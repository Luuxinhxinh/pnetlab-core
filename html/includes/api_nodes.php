<?php
# vim: syntax=php tabstop=4 softtabstop=0 noexpandtab laststatus=1 ruler

/**
 * html/includes/api_nodes.php
 *
 * Nodes related functions for REST APIs.
 *
 * @author Andrea Dainese <andrea.dainese@gmail.com>
 * @copyright 2014-2016 Andrea Dainese
 * @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
 * @link http://www.unetlab.com/
 * @version 20160719
 */

/**
 * Function to add a node to a lab.
 *
 * @param   Lab     $lab                Lab
 * @param   Array   $p                  Parameters
 * @param   bool    $o                  True if need to add ID to name
 * @return  Array                       Return code (JSend data)
 */
function apiAddLabNode($lab, $p, $o)
{
	if (isset($p['numberNodes']))
		$numberNodes = $p['numberNodes'];

	$default_name = $p['name'];
	if ($default_name == "R")
		$o = True;

	// Capture and remove cluster_host before addNode so it never reaches the XML.
	$addPlacementHost = isset($p['cluster_host']) ? max(0, min(2, (int) $p['cluster_host'])) : null;
	unset($p['cluster_host']);

	$ids = array();
	$no_array = false;
	$initLeft = (int)$p['left'];
	$initTop = (int)$p['top'];
	if (!isset($numberNodes)) {
		$numberNodes = 1;
		$no_array = true;
	}
	for ($i = 1; $i <= $numberNodes; $i++) {
		if ($i > 1) {
			$p['left'] =  $initLeft + (($i - 1) % 5)   * 60;
			$p['top'] =  $initTop + (intval(($i - 1) / 5)  * 80);
		}
		$id = $lab->getFreeNodeId();
		//if ( $id > 127 ) { $rc = 20046 ;  break ;}
		// Adding node_id to node_name if required
		if ($o == True && $default_name || $numberNodes > 1) $p['name'] = $default_name . $lab->getFreeNodeId();

		// Adding the node
		$rc = $lab->addNode($p);
		if ($rc === 0 && $addPlacementHost !== null && function_exists('cluster_placement_set')) {
			cluster_placement_set($lab->getId(), $id, $addPlacementHost);
		}
		$ids[] = $id;
	}
	if ($rc === 0) {

		$output['code'] = 201;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60023];
		// Return the created node id(s) so API callers don't have to re-read
		// the whole topology to find what they just added. Single add => id;
		// multi-add (numberNodes) => the first id, full list in ids.
		$output['data'] = ['id' => $ids[0], 'ids' => $ids];

		$data = apiGetLabNodes($lab, getUser()['html5']);
		if ($data['status'] == 'success') {
			$data = $data['data'];
			$output['update'] = ['nodes' => $data];
		}
	} else {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}

/**
 * Function to delete a lab node.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $id                 Node ID
 * @return  Array                       Return code (JSend data)
 */
function apiDeleteLabNode($lab, $id, $tenant)
{
	// Refuse to delete a locked node.
	$nodes = $lab->getNodes();
	if (isset($nodes[$id]) && $nodes[$id]->isLocked()) {
		return [
			'code'    => 400,
			'status'  => 'fail',
			'message' => 'Cannot delete: node is locked',
		];
	}

	// Delete all tmp files for the node

	$users = getAllUser();
	$userPod = [];
	foreach ($users as $user) {
		$userPod[$user['pod']] = $user;
	}

	$nodeSessions = getAllSessionOfNode($lab->getId(), $id);

	$using = [];
	foreach ($nodeSessions as $nodeSession) {
		if ($nodeSession['node_session_status'] == 2 || $nodeSession['node_session_status'] == 3) {
			$using[] = $userPod[$nodeSession['lab_session_pod']]['username'];
		}
	}

	if (count($using) > 0) {
		throw new ResponseException('node_session_running_alert', ['data' => implode(', ', $using)]);
	}

	$fail = node_wrapper_exec($lab, $id, 'delete', $tenant, $o, $rc, 600);
	if ($fail !== null) return $fail;
	error_log(date('M d H:i:s ') . 'INFO: delete node ' . $id . ' via broker rc=' . $rc);

	// Clear placement so a re-used nid doesn't inherit a stale host.
	if (function_exists('cluster_placement_set')) {
		cluster_placement_set($lab->getId(), $id, 0);
	}

	// Deleting the node
	$rc = $lab->deleteNode($id);
	if ($rc === 0) {

		$output['code'] = 201;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60023];

		$data = apiGetLabNodes($lab, getUser()['html5']);
		if ($data['status'] == 'success') {
			$data = $data['data'];
			$output['update'] = ['nodes' => $data];
		}
	} else {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}

/**
 * Function to edit a lab node.
 *
 * @param   Lab     $lab                Lab
 * @param   Array   $p                  Parameters
 * @return  Array                       Return code (JSend data)
 */
function apiEditLabNode($lab, $p)
{
	// Intercept cluster_host: store in DB, strip from XML params.
	if (isset($p['cluster_host']) && function_exists('cluster_placement_set')) {
		cluster_placement_set($lab->getId(), (int) ($p['id'] ?? 0), (int) $p['cluster_host']);
		unset($p['cluster_host']);
	}

	// Edit node
	$rc = $lab->editNode($p);

	if ($rc === 0) {


		$output['code'] = 201;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60023];

		$data = apiGetLabNodes($lab, getUser()['html5']);
		if ($data['status'] == 'success') {
			$data = $data['data'];
			$output['update'] = ['nodes' => $data];
		}
	} else {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}
/**
 * Function to edit multiple lab node.
 *
 * @param   Lab     $lab                Lab
 * @param   Array   $p                  Parameters
 * @return  Array                       Return code (JSend data)
 */
function apiEditLabNodes($lab, $p)
{
	// Edit node
	//$rc=$lab -> editNode
	foreach ($p as $node) {
		if (isset($node['cluster_host']) && function_exists('cluster_placement_set')) {
			cluster_placement_set($lab->getId(), (int) ($node['id'] ?? 0), (int) $node['cluster_host']);
			unset($node['cluster_host']);
		}
		$node['save'] = 0;
		$rc = $lab->editNode($node);
	}
	$rc = $lab->save();
	if ($rc === 0) {


		$output['code'] = 201;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60023];

		$data = apiGetLabNodes($lab, getUser()['html5']);
		if ($data['status'] == 'success') {
			$data = $data['data'];
			$output['update'] = ['nodes' => $data];
		}
	} else {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}
/**
 * Function to export a single node.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $id                 Node ID
 * @param   int     $tenant             Tenant ID
 * @return  Array                       Return code (JSend data)
 */
function apiExportLabNode($lab, $id, $tenant)
{
	$fail = node_wrapper_exec($lab, $id, 'export', $tenant, $o, $rc, 600);
	if ($fail !== null) return $fail;
	error_log(date('M d H:i:s ') . 'INFO: export configuration node ' . $id . ' via broker rc=' . $rc);
	if ($rc == 0) {
		// Config exported
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][80058];
	} else {
		// Failed to export
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}

/**
 * Function to export all nodes.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $tenant             Tenant ID
 * @return  Array                       Return code (JSend data)
 */
function apiExportLabNodes($lab, $tenant)
{
	lab_wrapper_exec($lab, 'export', $tenant, $o, $rc, 600);
	error_log(date('M d H:i:s ') . 'INFO: export configuration via broker rc=' . $rc);
	if ($rc == 0) {
		// Nodes started
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][80057];
	} else {
		// Failed to start
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}

/*
 * Function to get a single lab node.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $id                 Node ID
 * @param   Array   $p                  Parameters
 * @return  Array                       Lab node (JSend data)
 */
function apiEditLabNodeInterfaces($lab, $id, $p)
{
	// Edit node interfaces
	$rc = $lab->connectNode($id, $p);

	if ($rc === 0) {
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60023];
	} else if ($rc === 1) { // EVE_STORE hot link
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = 'success';
	} else {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = isset($GLOBALS['messages'][$rc]) ? $GLOBALS['messages'][$rc] : $rc;
	}
	return $output;
}

/**
 * Function to get a single lab node.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $id                 Node ID
 * @return  Array                       Lab node (JSend data)
 */
function apiGetLabNode($lab, $id, $html5)
{
	// Getting node
	if (isset($lab->getNodes()[$id])) {
		$node = $lab->getNodes()[$id];

		// Printing node
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60025];
		$output['data'] = array(
			'id' => $id,
			'status' => $node->getStatus(),
			'template' => $node->getTemplate(),
			'type' => $node->getNType(),
			'url' => $node->getConsoleUrl($html5),
			'url_2nd' => $node->getSecondConsoleUrl($html5),
			'session' => $node->getSession(),
			'port' => $node->getPort(),
			'port_2nd' => $node->getSecondPort(),
			'console' => $node->getconsole(),
			'console_2nd' => $node->getconsole_2nd(),

		);

		$options = $node->getOptions();
		foreach ($options as $key => $value) {
			$output['data'][$key] = get($value, '');
		}
		if (cluster_enabled() && function_exists('cluster_placement_get')) {
			$output['data']['cluster_host'] = cluster_placement_get($lab->getId(), $id);
		}
	} else {
		// Node not found
		$output['code'] = 404;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][20024];
	}
	return $output;
}

/**
 * Function to probe whether a node's console web GUI is actually answering
 * HTTP(S) requests yet (webwait loader for http/https docker consoles: the
 * container starts instantly and docker-proxy accepts TCP connections on the
 * published host port immediately, but the in-container web GUI daemon can
 * take 10-15s to actually start listening/responding). A plain TCP connect
 * (fsockopen) therefore reports "up" the moment docker-proxy is listening —
 * long before the GUI is ready — which is a false positive: webwait.js
 * redirects the user into the console and they hit a browser connection
 * error for the remainder of the boot window. Issuing a real HTTP(S) request
 * and checking that a status line actually came back avoids that false
 * positive: docker-proxy alone will never produce an HTTP response, only the
 * in-container GUI can. Host+port+scheme are derived from the node's OWN
 * console URL (the same consoleHost()/getPort() device.php uses to build
 * getConsoleUrl) — the caller only supplies a node id and which=1|2, never a
 * host/port, so this cannot be used to probe an arbitrary target (no SSRF).
 *
 * @param   Lab     $lab                Lab
 * @param   int     $id                 Node ID
 * @param   int     $which              1 = primary console, 2 = second console
 * @return  Array                       {up: bool} (JSend data)
 */
function apiPortcheckLabNode($lab, $id, $which)
{
	if (!isset($lab->getNodes()[$id])) {
		$output['code'] = 404;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][20024];
		return $output;
	}
	$node = $lab->getNodes()[$id];
	// html5=0 forces the raw scheme://host:port form for every console type
	// (including http/https — see device.php getConsoleUrl), which is all we
	// need to parse scheme+host+port out of.
	$url = ($which == 2) ? $node->getSecondConsoleUrl(0) : $node->getConsoleUrl(0);
	$parts = parse_url((string) $url);
	$scheme = isset($parts['scheme']) && $parts['scheme'] !== '' ? $parts['scheme'] : 'http';
	$host = isset($parts['host']) ? $parts['host'] : '';
	$port = isset($parts['port']) ? (int) $parts['port'] : 0;

	$up = false;
	if ($host !== '' && $port > 0) {
		// Only http/https schemes have a real HTTP responder behind them
		// (telnet/vnc/rdp/spice consoles don't speak HTTP); fall back to a
		// plain TCP probe for those so portcheck keeps working for them.
		if ($scheme === 'http' || $scheme === 'https') {
			$probeUrl = $scheme . '://' . $host . ':' . $port . '/';
			if (function_exists('curl_init')) {
				$ch = curl_init($probeUrl);
				curl_setopt_array($ch, array(
					CURLOPT_RETURNTRANSFER => true,
					CURLOPT_NOBODY => false, // some minimal Go handlers 405 on HEAD; GET instead
					CURLOPT_CONNECTTIMEOUT => 1,
					CURLOPT_TIMEOUT => 2,
					CURLOPT_SSL_VERIFYPEER => false, // node consoles use self-signed certs
					CURLOPT_SSL_VERIFYHOST => 0,
					CURLOPT_FOLLOWLOCATION => false,
					CURLOPT_RANGE => '0-0', // ask the server to short-circuit the body
				));
				curl_exec($ch);
				$errno = curl_errno($ch);
				$httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
				curl_close($ch);
				// Any HTTP status (200/301/303/401/405/...) means the GUI is
				// answering; connection refused/reset/timeout means it isn't.
				$up = ($errno === 0 && $httpCode > 0);
			} else {
				// curl unavailable: fall back to a stream-context HTTP probe.
				$context = stream_context_create(array(
					'http' => array(
						'method' => 'GET',
						'timeout' => 2,
						'ignore_errors' => true,
					),
					'ssl' => array(
						'verify_peer' => false,
						'verify_peer_name' => false,
					),
				));
				$result = @file_get_contents($probeUrl, false, $context);
				if ($result !== false && isset($http_response_header) && !empty($http_response_header)) {
					$up = (bool) preg_match('#^HTTP/\S+\s+\d{3}#', $http_response_header[0]);
				}
			}
		} else {
			$errno = 0;
			$errstr = '';
			$fp = @fsockopen($host, $port, $errno, $errstr, 1.0);
			if ($fp) {
				$up = true;
				fclose($fp);
			}
		}
	}

	$output['code'] = 200;
	$output['status'] = 'success';
	$output['message'] = '';
	$output['data'] = array('up' => $up);
	return $output;
}

/**
 * Function to get all lab nodes.
 *
 * @param   Lab     $lab                Lab
 * @return  Array                       Lab nodes (JSend data)
 */
function apiGetLabNodes($lab, $html5)
{
	// Getting node(s)
	$nodes = $lab->getNodes();
	// Printing nodes
	$output['code'] = 200;
	$output['status'] = 'success';
	$output['message'] = $GLOBALS['messages'][60026];
	$output['data'] = array();
	if (!empty($nodes)) {
		foreach ($nodes as $node_id => $node) {
			$nodeData = array(
				'id' => $node_id,
				'status' => $node->getStatus(),
				'template' => $node->getTemplate(),
				'type' => $node->getNType(),
				'url' => $node->getConsoleUrl($html5),
				'url_2nd' => $node->getSecondConsoleUrl($html5),
				'port' => $node->getPort(),
				'port_2nd' => $node->getSecondPort(),
				'session' => $node->getSession(),
				'console' => $node->getconsole(),
				'console_2nd' => $node->getconsole_2nd(),
			);
			$options = $node->getOptions();
			foreach ($options as $key => $value) {
				if ($key == 'config_data' || $key == 'multi_config') continue;
				$nodeData[$key] = get($value, '');
			}

			$nodeData['lock'] = (int) $node->getLock();

			$nodeData['serials'] = [];
			$nodeData['ethernets'] = [];

			$ethernets = $node->getEthernets();
			foreach ($ethernets as $interface_id => $interface) {
				$nodeData['ethernets'][$interface_id] = [
					'id' => $interface_id,
					'name' => $interface->getName(),
					'network_id' => $interface->getNetworkId(),
					'quality' => (object)$interface->getQuality(),
					'suspend' => $interface->getSuspendStatus(),
					'style' => $interface->getInterfaceStyle(),
				];
			}

			$serials = $node->getSerials();
			foreach ($serials as $interface_id => $interface) {
				$nodeData['serials'][$interface_id] = [
					'id' => $interface_id,
					'name' => $interface->getName(),
					'style' => $interface->getInterfaceStyle(),
					'remote_id' => $interface->getRemoteId(),
					'remote_if' => $interface->getRemoteIf()
				];
			}

			$nodeData['serials'] = (object)$nodeData['serials'];
			$nodeData['ethernets'] = (object)$nodeData['ethernets'];

			if (cluster_enabled() && function_exists('cluster_placement_get')) {
				$nodeData['cluster_host'] = cluster_placement_get($lab->getId(), $node_id);
			}

			$output['data'][$node_id] = $nodeData;
		}
	}

	return $output;
}

/**
 * Function to get all node interfaces.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $id                 Node ID
 * @return  Array                       Node interfaces (JSend data)
 */
function apiGetLabNodeInterfaces($lab, $id)
{
	// Getting node
	if (isset($lab->getNodes()[$id])) {
		$node = $lab->getNodes()[$id];

		// Printing node
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60025];
		$output['data'] = array();
		// Addint node type to properly sort IOL interfaces
		$output['data']['id'] = (int) $id;
		$output['data']['sort'] = $node->getNType();

		// Getting interfaces
		$ethernets = array();
		foreach ($node->getEthernets() as $interface_id => $interface) {
			$ethernets[$interface_id] = array(
				'name' => $interface->getName(),
				'network_id' => $interface->getNetworkId(),
				'type' => 'ethernet',
				'source' => 'node' . $id,
				'source_type' => 'node',
				'source_label' => $interface->getName(),
				'source_quality' => (object)$interface->getQuality(),
				'destination' => 'network' . $interface->getNetworkId(),
				'destination_type' => 'network',
				'destination_label' => '',
				'style' => $interface->getStyle(),
				'linkstyle' => $interface->getLinkstyle(),
				'color' => $interface->getColor(),
				'label' => $interface->getLabel(),
				'linkcfg' => $interface->getLinkcfg(),
				'labelpos' => $interface->getLabelpos(),
				'dstpos' => $interface->getDstpos(),
				'srcpos' => $interface->getSrcpos(),

			);
		}
		$serials = array();
		foreach ($node->getSerials() as $interface_id => $interface) {
			try {
				$remoteId = $interface->getRemoteId();
				$remoteIf = $interface->getRemoteIf();
				$serials[$interface_id] = array(
					'name' => $interface->getName(),
					'remote_id' => $remoteId,
					'remote_if' => $remoteIf,
					'remote_if_name' => $remoteId ? $lab->getNodes()[$remoteId]->getSerials()[$remoteIf]->getName() : '',
				);
			} catch (Exception $e) {
			}
		}

		$output['data']['ethernet'] = (object) $ethernets;
		$output['data']['serial'] = (object) $serials;

		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60030];
	} else {
		// Node not found
		$output['code'] = 404;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][20024];
	}
	return $output;
}

function apiGetAllLabNodeInterfaces($lab)
{
	// Getting node
	$nodes = $lab->getNodes();
	$nodeInterface = [];
	foreach ($nodes as $id => $node) {
		$output = apiGetLabNodeInterfaces($lab, $id);
		if ($output['status'] == 'success') {
			$nodeInterface[$id] = $output['data'];
		}
	}
	return $nodeInterface;
}


/**
 * Function to get node template.
 *
 * @param   Array   $p                  Parameters
 * @return  Array                       Node template (JSend data)
 */
function apiGetLabNodeTemplate($template)
{

	if (!is_file(BASE_DIR . '/html/'. TPL_DIR .'/' . $template . '.yml')) {
		throw new ResponseException('Can not found template');
	}

	$p = yaml_parse_file(BASE_DIR . '/html/'. TPL_DIR .'/' . $template . '.yml');
	$p['template'] = $template;
	if(isset($p['qemu_options'])){
		$re = '/\'|"|\\\\"|\\\\\'/m';
		$p['qemu_options'] = preg_replace($re, "'", $p['qemu_options']);
	}

	$params = [];
	$params['type'] = ['value' => $p['type'], 'show' => '0'];
	$params['template'] = ['value' => $p['template'], 'show' => '0'];

	if (is_file('/opt/unetlab/html/templates/device/' . $p['type'] . '.yml')) {
		if (  $template == 'timos' || $template == 'timos-ng') {
			$deviceP = yaml_parse_file('/opt/unetlab/html/templates/device/timos.yml');
		}
		else if ( $template == 'timoscpm' ||  $template == 'timoscpm-ng'){
			$deviceP = yaml_parse_file('/opt/unetlab/html/templates/device/timoscpm.yml');
		}
		else if ( $template == 'timosiom' || $template =='timosiom-ng'  ){
			$deviceP = yaml_parse_file('/opt/unetlab/html/templates/device/timosiom.yml');
		}
		else if ( $template == 'srlinux'  ){
			$deviceP = yaml_parse_file('/opt/unetlab/html/templates/device/srlinux.yml');
		}
		else if ( $template == 'ceos'  ){
			$deviceP = yaml_parse_file('/opt/unetlab/html/templates/device/ceos.yml');
		}
		else if ( $template == 'vios'  || $template == 'viosl2' ){
			$deviceP = yaml_parse_file('/opt/unetlab/html/templates/device/vios.yml');
		}
		else {
		$deviceP = yaml_parse_file('/opt/unetlab/html/templates/device/' . $p['type'] . '.yml');
		}
		foreach ($deviceP as $key => $value) {
			if (is_array($value)) {
				$params[$key] = $value;
			} else {
				$params[$key] = ['value' => $value];
			}
			if (!isset($params[$key]['value'])) $params[$key]['value'] = '';
		}
	}

	// Image
	if ($p['type'] != 'vpcs') {
		$node_images = listNodeImages($p['type'], $p['template']);
		if (!isset($params['image'])) $params['image'] = [];
		$params['image']['type'] = 'list';
		$params['image']['value'] = '';
		$params['image']['options'] = array();

		if (is_array($node_images)) {
			$params['image']['value'] = end($node_images);
			$params['image']['options'] = $node_images;
		}
	}


	// Qemu Options
	if ($p['type'] == "qemu") {

		$qemu = scandir('/opt');
		$qemuOption = [];
		foreach ($qemu as $version) {
			if (preg_match('/qemu-([\d\.]+)/', $version, $matches)) {
				$qemuOption[$matches[1]] = $matches[1];
			}
		}
		if (is_dir('/opt/qemu')) {
			$qemuDefault = readlink('/opt/qemu');
			$qemuDefault = str_replace('qemu-', '', $qemuDefault);
		}
		$qemuOption[$qemuDefault] = $qemuDefault . "(Default)";

		if (!isset($params['qemu_version'])) $params['qemu_version'] = [];
		$params['qemu_version']['type'] = 'list';
		$params['qemu_version']['value'] = $qemuDefault;
		$params['qemu_version']['options'] = $qemuOption;
	};

	// Icon

	if (!isset($params['icon'])) $params['icon'] = [];
	$params['icon']['type'] = 'list';
	$params['icon']['value'] = '';
	$params['icon']['options'] = listNodeIcons();

	// Cluster placement — only offered once at least one satellite has joined,
	// so single-host installs never see the field.
	if (cluster_enabled()) {
		$runOn = [0 => 'Master'];
		foreach (cluster_hosts() as $hid => $h) {
			$runOn[$hid] = $h['host_name'] . ' (' . $h['host_ip'] . ')';
		}
		if (!isset($params['cluster_host'])) $params['cluster_host'] = [];
		$params['cluster_host']['type'] = 'list';
		$params['cluster_host']['value'] = 0;
		$params['cluster_host']['options'] = $runOn;
	}

	foreach ($p as $key => $value) {
		if (!isset($params[$key])) $params[$key] = [];
		if (is_array($value)) {
			$params[$key] = array_replace($params[$key], $value);
		} else {
			$params[$key] = array_replace($params[$key], ['value' => $value]);
		}

		if (!isset($params[$key]['value'])) $params[$key]['value'] = '';
	}

	// Apply admin-saved per-template default overrides (upgrade-safe side store)
	// so every Add/Edit Node starts from the saved values. Factory defaults stand
	// when no override file exists. See includes/api_templatedefaults.php.
	if (function_exists('template_defaults_apply')) {
		template_defaults_apply($params, $template);
	}

	// TODO must check lot of parameters
	$output['code'] = 200;
	$output['status'] = 'success';
	$output['message'] = '';
	$output['data'] = array();
	$output['data']['options'] = $params;

	return $output;
}

/**
 * Function to start a single node.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $id                 Node ID
 * @param   int     $tenant             Tenant ID
 * @return  Array                       Return code (JSend data)
 */
function apiStartLabNode($lab, $id, $tenant)
{
	set_time_limit(0);
	/*$cmd  = ' sudo systemd-run -G --no-block --service-type=simple --uid=0 --gid=32768 --unit=pnet_'.$tenant.'@'.$lab->getSession().'_'.$id;
	$cmd .= ' /opt/unetlab/wrappers/unl_wrapper';*/

	$fail = node_wrapper_exec($lab, $id, 'start', $tenant, $o, $rc, 600);
	if ($fail !== null) return $fail;
	error_log(date('M d H:i:s ') . 'INFO: starting node ' . $id . ' via broker rc=' . $rc);
	if ($rc == 0) {
		// Nodes started
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][80049];
		// cross-host links: (re)stitch VXLAN overlays for networks this lab
		// spans across cluster hosts (no-op on single-host labs)
		if (cluster_enabled()) {
			cluster_sync_overlay($lab);
		}
	} else {
		// Failed to start
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}

/**
 * Function to start all nodes.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $tenant             Tenant ID
 * @return  Array                       Return code (JSend data)
 */
// function apiStartLabNodes($lab, $tenant, $lab_session)
// {
// 	$cmd = 'sudo /opt/unetlab/wrappers/unl_wrapper';
// 	$cmd .= ' -a start';
// 	$cmd .= ' -T ' . $tenant;
// 	$cmd .= ' -S ' . $lab_session;
// 	$cmd .= ' -F "' . $lab->getPath() . '/' . $lab->getFilename() . '"';
// 	$cmd .= ' 2>> /opt/unetlab/data/Logs/unl_wrapper.txt';
// 	exec($cmd, $o, $rc);
// 	error_log(date('M d H:i:s ') . 'INFO: starting nodes ' . $cmd);
// 	if ($rc == 0) {
// 		// Nodes started
// 		$output['code'] = 200;
// 		$output['status'] = 'success';
// 		$output['message'] = $GLOBALS['messages'][80048];
// 	} else {
// 		// Failed to start
// 		$output['code'] = 400;
// 		$output['status'] = 'fail';
// 		$output['message'] = $GLOBALS['messages'][$rc];
// 	}
// 	return $output;
// }

/**
 * Function to stop a single node.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $id                 Node ID
 * @param   int     $tenant             Tenant ID
 * @return  Array                       Return code (JSend data)
 */

function apiStopLabNode($lab, $id, $tenant)
{
	// Refuse to stop a locked node.
	$nodes = $lab->getNodes();
	if (isset($nodes[$id]) && $nodes[$id]->isLocked()) {
		return [
			'code'    => 400,
			'status'  => 'fail',
			'message' => 'Cannot stop: node is locked',
		];
	}

	$fail = node_wrapper_exec($lab, $id, 'stop', $tenant, $o, $rc, 600);
	if ($fail !== null) return $fail;
	error_log(date('M d H:i:s ') . 'INFO: stop node ' . $id . ' via broker rc=' . $rc);
	if ($rc == 0) {
		deleteWiresharkByNode(checkDatabase(), $lab, $id);
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][80051];
	} else {
		// Failed to stop
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}


// /**
//  * Function to stop all nodes.
//  *
//  * @param   Lab     $lab                Lab
//  * @param   int     $tenant             Tenant ID
//  * @return  Array                       Return code (JSend data)
//  */
// function apiStopLabNodes($lab, $tenant)
// {
// 	$cmd = 'sudo /opt/unetlab/wrappers/unl_wrapper';
// 	$cmd .= ' -a stop';
// 	$cmd .= ' -T ' . $tenant;
// 	$cmd .= ' -S ' . $lab->getSession();
// 	$cmd .= ' -F "' . $lab->getPath() . '/' . $lab->getFilename() . '"';
// 	$cmd .= ' 2>> /opt/unetlab/data/Logs/unl_wrapper.txt';
// 	exec($cmd, $o, $rc);
// 	error_log(date('M d H:i:s ') . 'INFO: stop all nodes ' . $cmd);
// 	if ($rc == 0) {
// 		deleteWiresharkByLab(checkDatabase(), $lab);
// 		$output['code'] = 200;
// 		$output['status'] = 'success';
// 		$output['message'] = $GLOBALS['messages'][80050];
// 	} else {
// 		// Failed to start
// 		$output['code'] = 400;
// 		$output['status'] = 'fail';
// 		$output['message'] = $GLOBALS['messages'][$rc];
// 	}
// 	return $output;
// }

/**
 * Function to wipe a single node.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $id                 Node ID
 * @param   int     $tenant             Tenant ID
 * @return  Array                       Return code (JSend data)
 */
function apiWipeLabNode($lab, $id, $tenant)
{
	// Refuse to wipe a locked node.
	$nodes = $lab->getNodes();
	if (isset($nodes[$id]) && $nodes[$id]->isLocked()) {
		return [
			'code'    => 400,
			'status'  => 'fail',
			'message' => 'Cannot wipe: node is locked',
		];
	}

	$fail = node_wrapper_exec($lab, $id, 'wipe', $tenant, $o, $rc, 600);
	if ($fail !== null) return $fail;
	error_log(date('M d H:i:s ') . 'INFO: wiping node ' . $id . ' via broker rc=' . $rc);
	if ($rc == 0) {
		deleteWiresharkByNode(checkDatabase(), $lab, $id);
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][80053];
	} else {
		// Failed to start
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}

/**
 * Function to wipe all nodes.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $tenant             Tenant ID
 * @return  Array                       Return code (JSend data)
 */
function apiWipeLabNodes($lab, $tenant)
{
	lab_wrapper_exec($lab, 'wipe', $tenant, $o, $rc, 600);
	error_log(date('M d H:i:s ') . 'INFO: wiping nodes via broker rc=' . $rc);
	if ($rc == 0) {
		deleteWiresharkByLab(checkDatabase(), $lab);
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][80052];
	} else {
		// Failed to start
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}


/** Update console port for Node */

function apiEditNodePort($lab, $node_id, $port)
{
	$nodes = $lab->getNodes();
	if (!isset($nodes[$node_id])) throw new Exception('Undefine Node');
	//if ($port > PORT || $port < PORT) throw new Exception('Port must be in range 30000 - 40000');
	$db = checkDatabase();
	$query = 'SELECT * FROM ' . NODE_SESSIONS_TABLE . ' WHERE ' . NODE_SESSION_PORT . ' = :port';
	$statement = $db->prepare($query);
	$statement->execute([
		'port' => $port
	]);
	$result = $statement->fetchAll(PDO::FETCH_ASSOC);
	if (isset($result[0])) throw new Exception('Port is already in used');

	$node = $nodes[$node_id];
	$query = 'UPDATE ' . NODE_SESSIONS_TABLE . ' SET ' . NODE_SESSION_PORT . ' = :port WHERE ' . NODE_SESSION_ID . '= :node_session_id';
	$statement = $db->prepare($query);
	$statement->execute([
		'port' => $port,
		'node_session_id' => $node->getSession()
	]);
	if($node->getNType() == 'docker'){
		$log = 'Change Port successfully. Restart or Wipe Node to take effect';
	}else{
		$log = 'Change Port successfully. Restart Node to take effect';
	}

	$node->setPort($port);
	$data = apiGetLabNodes($lab, getUser()['html5']);

	$output['code'] = 200;
	$output['status'] = 'success';
	$output['message'] = $log;
	$output['update'] = $data;
	return $output;
}
function apiEditNodePort_2nd($lab, $node_id, $port_2nd)
{
	$nodes = $lab->getNodes();
	if (!isset($nodes[$node_id])) throw new Exception('Undefine Node');
	//if ($port > PORT || $port < PORT) throw new Exception('Port must be in range 30000 - 40000');
	$db = checkDatabase();
	$query = 'SELECT * FROM ' . NODE_SESSIONS_TABLE . ' WHERE ' . NODE_SESSION_PORT_2ND . ' = :port_2nd';
	$statement = $db->prepare($query);
	$statement->execute([
		'port_2nd' => $port_2nd
	]);
	$result = $statement->fetchAll(PDO::FETCH_ASSOC);
	if (isset($result[0])) throw new Exception('Port_2nd is already in used');

	$node = $nodes[$node_id];
	$query = 'UPDATE ' . NODE_SESSIONS_TABLE . ' SET ' . NODE_SESSION_PORT_2ND . ' = :port_2nd WHERE ' . NODE_SESSION_ID . '= :node_session_id';
	$statement = $db->prepare($query);
	$statement->execute([
		'port_2nd' => $port_2nd,
		'node_session_id' => $node->getSession()
	]);
	if($node->getNType() == 'docker'){
		$log = 'Change Port_2nd successfully. Restart or Wipe Node to take effect';
	}else{
		$log = 'Change Port_2nd successfully. Restart Node to take effect';
	}

	$node->setPort_2nd($port_2nd);
	$data = apiGetLabNodes($lab, getUser()['html5']);

	$output['code'] = 200;
	$output['status'] = 'success';
	$output['message'] = $log;
	$output['update'] = $data;
	return $output;
}

/**
 * Commit a qemu node's disk overlay — either INTO its shared base image, or out
 * to a new named image under addons/qemu.
 *
 * The old PNetLab line had this and it was lost in the re-root; the broker verb
 * (qemu_img) survived with no callers at all. This is the caller.
 *
 * Why admin-only: both modes write into /opt/unetlab/addons/qemu, which is
 * appliance-global state. `commit` in particular rewrites the base image every
 * OTHER lab's nodes are linked-cloned from, retroactively — it is not scoped to
 * the caller's lab in any way, so lab-edit permission is not the right gate.
 *
 * Why the node must be stopped: qemu holds an exclusive lock on the overlay
 * while it runs, and committing or converting a live disk yields a torn image.
 * qemu-img's own locking makes the broker fail closed regardless, but failing
 * here gives the user a sentence instead of a qemu-img error string.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $id                 Node ID
 * @param   string  $mode               'commit' | 'save_as'
 * @param   string  $dest               New image name (save_as only)
 * @return  Array                       Return code (JSend data)
 */
function apiCommitLabNode($lab, $id, $mode, $dest = '')
{
    if (!isAdmin()) {
        return ['code' => 403, 'status' => 'fail',
            'message' => 'Committing a node image is an admin operation'];
    }
    if ($mode !== 'commit' && $mode !== 'save_as') {
        return ['code' => 400, 'status' => 'fail', 'message' => 'Invalid mode'];
    }

    $nodes = $lab->getNodes();
    if (!isset($nodes[$id])) {
        return ['code' => 404, 'status' => 'fail', 'message' => 'Node not found'];
    }
    $node = $nodes[$id];

    if ($node->getNType() !== 'qemu') {
        return ['code' => 400, 'status' => 'fail',
            'message' => 'Only QEMU nodes have a disk image to commit'];
    }
    // 0 = stopped, 3 = building and stopped. Anything else is live.
    $status = $node->getStatus();
    if ($status !== 0 && $status !== 3) {
        return ['code' => 400, 'status' => 'fail',
            'message' => 'Stop the node first — its disk is in use while it runs'];
    }

    $running = $node->getRunningPath();
    if ($running === null || !is_dir($running)) {
        return ['code' => 400, 'status' => 'fail',
            'message' => 'Node has never been started, so it has no changes to commit'];
    }

    // Same disk-name shape device_qemu.php uses when it makes the linked clone.
    $disks = [];
    foreach (scandir($running) as $f) {
        if (preg_match('/^[a-zA-Z0-9]+\.qcow2$/', $f)) $disks[] = $running . '/' . $f;
    }
    if (!count($disks)) {
        return ['code' => 400, 'status' => 'fail',
            'message' => 'No disk overlay found for this node'];
    }

    // save_as: the broker validates and composes the destination, but reject an
    // obviously bad name here too so the user gets a real message rather than a
    // broker reject. Multi-disk nodes land every disk in the SAME new image dir,
    // which is exactly how addons/qemu/<image>/ is laid out.
    if ($mode === 'save_as') {
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/', (string) $dest)) {
            return ['code' => 400, 'status' => 'fail',
                'message' => 'Image name must start with a letter or digit; then letters, digits, . _ + -'];
        }
        if (is_dir('/opt/unetlab/addons/qemu/' . $dest)) {
            return ['code' => 400, 'status' => 'fail',
                'message' => 'An image named "' . $dest . '" already exists'];
        }
    }

    foreach ($disks as $disk) {
        // broker_call returns the full response array (ok/rc/out/err), NOT an
        // int rc. Treating it as one produced a PHP "Array to string
        // conversion" that surfaced as a 400 while the operation had actually
        // SUCCEEDED — the worst kind of failure report. Read ['rc'].
        $resp = ($mode === 'commit')
            ? broker_qemu_commit($disk)
            : broker_qemu_save_as($disk, $dest);
        $rc = is_array($resp) ? (int) get($resp['rc'], 255) : (int) $resp;
        $err = is_array($resp) ? trim((string) get($resp['err'], '')) : '';
        if ($rc !== 0) {
            error_log(sprintf('%sERROR: qemu_img %s failed for node %s disk %s rc=%d %s',
                date('M d H:i:s '), $mode, json_encode($id), basename($disk), $rc, $err));
            $detail = $err !== '' ? ' — ' . $err : '';
            return ['code' => 400, 'status' => 'fail',
                'message' => ($mode === 'commit'
                    ? 'Commit failed (rc ' . $rc . '); the base image is unchanged'
                    : 'Save failed (rc ' . $rc . '); no image was created') . $detail];
        }
    }

    // sprintf/json_encode rather than concatenation: a stray array in any of
    // these would raise "Array to string conversion", and a WARNING raised on
    // the success path turns a completed operation into a 400 -- which is
    // exactly what happened here once. Never build a log line out of
    // unvalidated shapes with '.'.
    error_log(sprintf('%sINFO: qemu_img %s node %s disks=%d dest=%s',
        date('M d H:i:s '), $mode, json_encode($id), count($disks), $dest));

    return ['code' => 200, 'status' => 'success',
        'message' => $mode === 'commit'
            ? 'Node changes committed into the base image'
            : 'Saved as new image "' . $dest . '"'];
}
