<?php

class Node
{


	private $type;
	private $template;
	private $tenant;
	private $host;
	private $session = null;
	private $session_host = 0;   // cluster host (0=master, 1/2=satellite)
	private $port;
	private $port_2nd;

	private $lab = null;
	private $lab_session = null;
	private $node_sessions = array();
	private $if_sessions = array();

	private $id;
	private $iol_id = null;
	private $lab_id;
	private $deviceFactory = null;
	private $params = [];


	public function __construct($p, $id, $tenant, $lab)
	{

		$this->params = $p;
		$this->lab = $lab;

		if (!isset($p['type']) || !isset($p['template'])) {
			error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][40000]);
			throw new Exception('40000');
			return 40000;
		}


		// Now building the node

		$this->id = (int) $id;
		$this->lab_id = $lab->getId();
		$this->lab_session = $lab->getSession();
		$this->template = $p['template'];
		$this->tenant = (int) $tenant;
		$this->type = $p['type'];

		$this->node_sessions = $lab->node_sessions;
		$this->if_sessions = $lab->if_sessions;

		if ($this->lab_session != null) {

			$node_session = $this->addNodeSession($this->lab_session, $this->id, $this->type);

			if ($node_session['result']) {
				$node_session = $node_session['data'];
				$this->port = $node_session['node_session_port'];
				$this->port_2nd = $node_session['node_session_port_2nd'];
				$this->session = $node_session['node_session_id'];
				$this->host = $node_session['node_session_pod'];
				// cluster host this session runs on (0=master, 1/2=satellite);
				// distinct from $host above, which is the tenant POD
				$this->session_host = isset($node_session['node_session_host'])
					? (int) $node_session['node_session_host'] : 0;
			} else {
				throw new Exception($node_session['message']);
			}
		}

		// auto import class and create device factory
		try {

			if (is_file('/opt/unetlab/html/devices/' . $this->type . '/device_' . $this->type . '.php')) {
				require_once('/opt/unetlab/html/devices/' . $this->type . '/device_' . $this->type . '.php');
			} else {
				emptyLabSession($tenant);
				throw new ResponseException('Not support device', ['data' => $this->type]);
			}

			

				if ( $this->template == 'timos-ng' || $this->template == 'timos' ) { 

					require_once('/opt/unetlab/html/devices/qemu/device_timos.php');
					$class = 'device_timos';
					$this->deviceFactory = new $class($this);
				} 
			    else if ( $this->template == 'timosiom-ng' || $this->template == 'timosiom') { 

					require_once('/opt/unetlab/html/devices/qemu/device_timosiom.php');
					$class = 'device_timosiom';
					$this->deviceFactory = new $class($this);
				} 
				else if ( $this->template == 'timoscpm-ng' || $this->template == 'timoscpm') { 
					require_once('/opt/unetlab/html/devices/qemu/device_timoscpm.php');
					$class = 'device_timoscpm';
					$this->deviceFactory = new $class($this);
				}
				else if ( $this->template == 'cat9kv' || $this->template == 'isrv') { 

					require_once('/opt/unetlab/html/devices/qemu/device_catalyst.php');
					$class = 'device_catalyst';
					$this->deviceFactory = new $class($this);
				}
				else if ( $this->template == 'srlinux') { 

					require_once('/opt/unetlab/html/devices/' . $this->type . '/device_srlinux.php');
					$class = 'device_srlinux';
					$this->deviceFactory = new $class($this);
				}  else  {
					if (is_file('/opt/unetlab/html/devices/' . $this->type . '/device_' . $this->template . '.php')) {
					require_once('/opt/unetlab/html/devices/' . $this->type . '/device_' . $this->template . '.php');
					$class = 'device_' . $this->template;
					$this->deviceFactory = new $class($this);
					}
				}

			if (!$this->deviceFactory) {
				$class = 'device_'. $this->type;
				$this->deviceFactory = new $class($this);
			}
			
			if (!$this->deviceFactory) {
				emptyLabSession($tenant);
				throw new ResponseException('Not support device', ['data' => $this->template]);
			}

			$this->edit($p);
			
		} catch (Exception $e) {
			emptyLabSession($tenant);
			throw new ResponseException('Not support device', ['data' => $this->template]);
		}
	}



	private function createNodeSession()
	{
		$db = checkDatabase();
		$query = 'SELECT node_session_id FROM node_sessions';
		$statement = $db->prepare($query);
		$statement->execute();
		$result = $statement->fetchAll(PDO::FETCH_ASSOC);
		$idColumn = array_column($result, 'node_session_id', 'node_session_id');
		$id = count($idColumn) + 1;
		while (isset($idColumn[$id % PORT])) {
			$id++;
		}
		return $id % PORT;
	}

	private function addNodeSession($lab_session, $node_id, $node_type)
	{

		try {
			if (isset($this->node_sessions[$node_id])) {
				$node_session = $this->node_sessions[$node_id];
			} else {
				
				$nodeModel = loadModel('node_sessions');
				
				$id = $this->createNodeSession($lab_session, $node_id);

				$lab = getLabFromSession($lab_session);
				// NOBLE/PHP8.3 hardening: getLabFromSession() returns null when no
				// lab_sessions row exists (e.g. a node start attempted before the lab
				// is opened, as the bare `unl_wrapper -a start` CLI path can do). On
				// PHP 8.3 the old `$lab['lab_session_pod']` below then fatals with
				// "Trying to access array offset on null". Fail gracefully instead —
				// the surrounding try/catch turns this into result=>false with a
				// meaningful message rather than a null-offset crash.
				if ($lab === null) {
					throw new Exception(
						'Lab session ' . $lab_session .
						' not found (open the lab to create its session before starting nodes).'
					);
				}
				$port = PORT + $id;
				$port_2nd = PORT_2ND + $id;
				$node_session = [
					'node_session_id' => $id,
					'node_session_nid' => $node_id,
					'node_session_lab' => $lab_session,
					'node_session_port' => $port,
					'node_session_port_2nd' => $port_2nd,
					'node_session_type' => $node_type,
					'node_session_workspace' => createRunningPath($lab_session, $id),
					'node_session_pod' => $lab['lab_session_pod'],
					'node_session_host' => (function_exists('cluster_placement_get') && $lab !== null)
					? cluster_placement_get($lab['lab_session_lid'], $node_id)
					: 0,
				];

				$nodeModel->insert($node_session);
			}

			return ['result' => true, 'message' => 'Success', 'data' => $node_session];
		} catch (Exception $e) {
			return ['result' => false, 'message' => $e->getMessage()];
		}
	}

	public function delNodeSession()
	{

		try {
			
			$nodeModel = loadModel('node_sessions');
			$nodeModel->drop([[
				'node_session_id' ,'=', $this->getSession(),
			]]);
			return ['result' => true, 'message' => 'Success'];
		} catch (Exception $e) {
			return ['result' => false, 'message' => $e->getMessage()];
		}
	}


	public function getIolId()
	{

		if ($this->type == 'iol') {
			if ($this->iol_id != null) return $this->iol_id;

			$db = checkDatabase();
			$query = 'SELECT * FROM ' . NODE_SESSIONS_TABLE . ' WHERE ' . NODE_SESSION_ID . ' = :id';
			$statement = $db->prepare($query);
			$statement->execute([
				'id' => $this->getSession()
			]);
			$result = $statement->fetch(PDO::FETCH_ASSOC);
			if (isset($result[NODE_SESSION_IOL]) && $result[NODE_SESSION_IOL] > 0) {
				$this->iol_id = $result[NODE_SESSION_IOL];
				return $this->iol_id;
			};

			$query = 'SELECT ' . NODE_SESSION_IOL . ' FROM ' . NODE_SESSIONS_TABLE . ' WHERE ' . NODE_SESSION_POD . '=:pod AND ' . NODE_SESSION_LAB . ' =:lab_session AND ' . NODE_SESSION_TYPE . '=:type';
			$statement = $db->prepare($query);
			$statement->execute(['pod' => $this->host, 'lab_session' => $this->lab_session, 'type' => 'iol']);
			$result = $statement->fetchAll(PDO::FETCH_ASSOC);
			$idColumn = array_column($result, NODE_SESSION_IOL, NODE_SESSION_IOL);

			for ($i = 1; $i <= 512; $i++) {
				if (!isset($idColumn[$i])) {
					$iol_id = $i;
					break;
				}
			}

			$this->iol_id = $iol_id;

			$query = 'UPDATE ' . NODE_SESSIONS_TABLE . ' SET ' . NODE_SESSION_IOL . '=:iol_id WHERE ' . NODE_SESSION_ID . ' = :id';
			$statement = $db->prepare($query);
			$statement->execute(['iol_id' => $iol_id, 'id' => $this->getSession()]);

			return $this->iol_id;
		}
		return null;
	}


	public function edit($p)
	{
		$result = $this->deviceFactory->editParams($p);
		$this->addIfSessions();
		return $result;
	}

	public function export()
	{
		return $this->deviceFactory->export();
	}

	public function getActiveConfig()
	{
		return $this->lab->getMulti_config_active();
	}

	public function addMultiCfg($config_data, $name)
	{
		try {
			$this->deviceFactory->multi_config[$name] = $config_data;
			return true;
		} catch (Exception $e) {
			return false;
		}
	}

	public function editMultiCfg($config_data, $name)
	{
		try {
			if (isset($this->deviceFactory->multi_config[$name])){
				$this->deviceFactory->multi_config[$name] = $config_data;
				// if($this->getActiveConfig() == $name){
				// 	$this->updateStartUpConfig($config_data);
				// }
			}
				
			return true;
		} catch (Exception $e) {
			return false;
		}
	}

	public function renameMultiCfg($oldName, $newName)
	{
		try {

			if (isset($this->deviceFactory->multi_config[$oldName])) {
				$this->deviceFactory->multi_config[$newName] = $this->deviceFactory->multi_config[$oldName];
				unset($this->deviceFactory->multi_config[$oldName]);
			}
			return true;
		} catch (Exception $e) {
			return false;
		}
	}

	public function delMultiCfg($name)
	{
		try {
			if (isset($this->deviceFactory->multi_config[$name])) {
				unset($this->deviceFactory->multi_config[$name]);
			}
			return true;
		} catch (Exception $e) {
			return false;
		}
	}

	public function getMultiCfg($name)
	{
		try {
			if (isset($this->deviceFactory->multi_config[$name])) {
				return $this->deviceFactory->multi_config[$name];
			} else {
				return '';
			}
		} catch (Exception $e) {
			return '';
		}
	}


	public function getId()
	{
		return $this->id;
	}

	public function getLid()
	{
		return $this->lab_id;
	}

	public function getNode($id)
	{
		$nodes = $this->lab->getNodes();
		return isset($nodes[$id]) ? $nodes[$id] : null;
	}

	public function getNetwork($id)
	{
		$network = $this->lab->getNetworks();
		return isset($network[$id]) ? $network[$id] : null;
	}

	public function getHost()
	{
		return $this->host;
	}

	public function getName()
	{
		return $this->deviceFactory->name;
	}

	/**
	 * @return the $multi_config_lab
	 */
	public function getMulti_config()
	{
		if (!isset($this->deviceFactory->multi_config) || $this->deviceFactory->multi_config == '') {
			return [];
		}
		return $this->deviceFactory->multi_config;
	}

	public function getParams()
	{
		return $this->params;
	}


	public function getOptions()
	{
		return $this->deviceFactory->getParams();
	}


	/**
	 * Method to get config bin.
	 * Configured startup-config
	 */
	public function getConfigData()
	{
		return $this->deviceFactory->config_data;
	}

	/**
	 * Method to get config bin.
	 * Configured startup-config
	 */
	public function getConfig()
	{
		return $this->deviceFactory->config;
	}


	public function getIcon()
	{
		return $this->deviceFactory->icon;
	}



	/**
	 * Method to get node console URL.
	 * 
	 * @return	string                      Node console URL
	 */
	public function getConsoleUrl($html5)
	{
		return $this->deviceFactory->getConsoleUrl($html5);
	}


	/**
	 * Method to get node console URL.
	 * 
	 * @return	string                      Node console URL
	 */
	public function getSecondConsoleUrl($html5)
	{
		return $this->deviceFactory->getSecondConsoleUrl($html5);
	}

	public function getGuacConsoleLink($index)
	{
		return $this->deviceFactory->getGuacConsoleLink($index);
	}

	public function getEthernets()
	{
		return $this->deviceFactory->getEthernets();
	}

	public function getImage()
	{
		return $this->deviceFactory->image;
	}

	public function getInterfaces()
	{
		return $this->getEthernets() + $this->getSerials();
	}

	public function getNType()
	{
		return $this->type;
	}

	public function getScriptTimeout()
	{
		return $this->lab->getScriptTimeout();
	}

	public function getconsole()
	{
		return $this->deviceFactory->getconsole();
	}
	public function getconsole_2nd()
	{
		return $this->deviceFactory->getconsole_2nd();
	}

	public function getPort()
	{
		return $this->port;
	}

	public function getSecondPort()
	{	
		if ($this->port_2nd == ''){
			return 10000 + $this->port;
		}
		return $this->port_2nd;
	}

	public function setPort($port)
	{
		return $this->port = $port;
	}
	public function setPort_2nd($port_2nd)
	{
		return $this->port_2nd = $port_2nd;
	}

	public function getSession()
	{
		return $this->session;
	}

	public function getLabSession()
	{
		return $this->lab_session;
	}

	public function getTenant(){
		return $this->tenant;
	}

	/**
	 * Method to get running path.
	 * 
	 * @return	string                      Running path
	 */
	public function getRunningPath()
	{
		if ($this->session == null) return null;
		return createRunningPath($this->lab_session, $this->session);
	}

	/**
	 * Method to get node Serial interfaces.
	 * 
	 * @return	Array                       Array of interfaces
	 */
	public function getSerials()
	{
		return $this->deviceFactory->getSerials();
	}
	public function getCpu()
	{
		return $this->deviceFactory->getCpu();
	}
	public function getRam()
	{
		return $this->deviceFactory->getRam();
	}

	/**
	 * Method to get node status.
	 * 
	 * @return	int                         0 is stopped, 1 is running, 2 is building and started, 3 is building and stopped
	 */
	public function getStatus()
	{
		return getNodeStatus($this->session, $this->type, $this->getRunningPath(), $this->port,
			$this->port_2nd, $this->session_host);
	}

	/** Cluster host this node's session runs on (0=master, 1/2=satellite). */
	public function getSessionHost()
	{
		return $this->session_host;
	}

	/** Check start quotas without publishing a running state. */
	private function checkRunningStart($session_id, $pod, $cpu, $ram){
		$db = checkDatabase();
		$hostLab = getUserByPod($pod);

		if(!$pod) throw new ResponseException('User not exist');
		$checkMaxCpu = false;
		if(isset($hostLab[USER_MAX_CPU]) && $hostLab[USER_MAX_CPU] > 0){
			$checkMaxCpu = true;

		}
		$checkMaxRam = false;
		if(isset($hostLab[USER_MAX_RAM]) && $hostLab[USER_MAX_RAM] > 0 ){
			$checkMaxRam = true;
		}

		if($checkMaxCpu){

			$get = 'SELECT SUM(' . NODE_CPU . ') as consume_cpu  FROM ' . NODE_SESSIONS_TABLE . ' WHERE ' . NODE_SESSION_POD . ' = :pod AND ' . NODE_SESSION_RUNNING . ' = 1 AND ' . NODE_SESSION_ID . ' <> :node_session_id';
			$statement = $db->prepare($get);
			$statement->execute([
				'pod' => $pod,
				'node_session_id' => $session_id,
			]);
			$result = $statement->fetch(PDO::FETCH_ASSOC);
			$consumeCpu = (int) $result['consume_cpu'];

			if( ($cpu + $consumeCpu ) > $hostLab[USER_MAX_CPU] ) throw new Exception('max cpu limit reached');
		}
		if($checkMaxRam){

			$get = 'SELECT SUM(' . NODE_RAM . ') as consume_ram  FROM ' . NODE_SESSIONS_TABLE . ' WHERE ' . NODE_SESSION_POD . ' = :pod AND ' . NODE_SESSION_RUNNING . ' = 1 AND ' . NODE_SESSION_ID . ' <> :node_session_id';
			$statement = $db->prepare($get);
			$statement->execute([
				'pod' => $pod,
				'node_session_id' => $session_id,
			]);
			$result = $statement->fetch(PDO::FETCH_ASSOC);
			$consumeRam = (int) $result['consume_ram'];

			if(($ram + $consumeRam ) > $hostLab[USER_MAX_RAM]) throw new Exception('max ram limit reached');
		}
	}

	/** Publish state only after the device action reports success. */
	private function updateRunning($session_id, $state, $cpu, $ram){
		$db = checkDatabase();
			$query = 'UPDATE ' . NODE_SESSIONS_TABLE . ' SET ' .NODE_SESSION_RUNNING. '= :node_session_running,' . NODE_CPU . '=:cpu,' . NODE_RAM . '=:ram  WHERE ' . NODE_SESSION_ID . '=:node_session_id';
			$update = $db->prepare($query);
			$update->execute([
				'node_session_running' => $state,
				'node_session_id' => $session_id,
				'cpu' => $cpu,
				'ram' => $ram,
			]);
	}

	/** Serialize a tenant's quota check/action/commit across master and satellites. */
	private function acquireRunningStartLock($pod)
	{
		$db = checkDatabase();
		$statement = $db->prepare('SELECT GET_LOCK(:lock_name, :timeout)');
		$statement->execute([
			'lock_name' => 'pnetlab-node-start-pod-' . (int) $pod,
			'timeout' => TIMEOUT,
		]);
		if ((int) $statement->fetchColumn() !== 1) {
			throw new RuntimeException('Timed out waiting for node start quota lock');
		}
	}

	private function releaseRunningStartLock($pod)
	{
		try {
			$db = checkDatabase();
			$statement = $db->prepare('SELECT RELEASE_LOCK(:lock_name)');
			$statement->execute([
				'lock_name' => 'pnetlab-node-start-pod-' . (int) $pod,
			]);
		} catch (Exception $e) {
			error_log(date('M d H:i:s ') . 'ERROR: failed to release node start quota lock: ' . $e->getMessage());
		}
	}

	/** Probe the host executing this wrapper, bypassing remote shared-DB status. */
	private function localProcessRunning()
	{
		$listening = $this->type === 'docker' ? null : snapshotListeningPorts();
		$status = getNodeStatus(
			$this->session,
			$this->type,
			$this->getRunningPath(),
			$this->port,
			$this->port_2nd,
			0,
			$listening
		);
		return in_array($status, [2, 3, 7], true);
	}

	/** Wait briefly for host process/listener state, not for guest boot readiness. */
	private function waitForLocalProcess($running)
	{
		$stoppedSamples = 0;
		// Five seconds covers the existing QEMU console-listener window while
		// remaining a host-process check rather than a guest boot/readiness wait.
		$attempts = max(1, min(50, (int) ceil((float) TIMEOUT * 10)));
		for ($attempt = 0; $attempt < $attempts; $attempt++) {
			$observed = $this->localProcessRunning();
			if ($running && $observed) {
				return true;
			}
			if (!$running) {
				$stoppedSamples = $observed ? 0 : $stoppedSamples + 1;
				if ($stoppedSamples >= 3) {
					return true;
				}
			}
			usleep(100000);
		}
		return false;
	}

	/**
	 * Method to get node template.
	 * 
	 * @return	string                      Node template
	 */
	public function getTemplate()
	{
		return $this->template;
	}

	public function start()
	{
		$pod = $this->getHost();
		$this->acquireRunningStartLock($pod);
		try {
			$this->checkRunningStart($this->getSession(), $pod, $this->getCpu(), $this->getRam());
			if ($this->localProcessRunning()) {
				// A concurrent/duplicate start already has a live process. Reconcile
				// shared state without launching or tearing down somebody else's run.
				$this->updateRunning($this->getSession(), '1', $this->getCpu(), $this->getRam());
				return 0;
			}
			$result = $this->deviceFactory->start();
			if (($result === 0 || $result === '0') && $this->waitForLocalProcess(true)) {
				try {
					$this->updateRunning($this->getSession(), '1', $this->getCpu(), $this->getRam());
				} catch (Exception $stateError) {
					$cleanupError = null;
					try {
						$cleanup = $this->deviceFactory->stop();
						if (($cleanup !== 0 && $cleanup !== '0') || !$this->waitForLocalProcess(false)) {
							$cleanupError = 'device remains running after state commit failure';
						}
					} catch (Exception $e) {
						$cleanupError = $e->getMessage();
					}
					if ($cleanupError !== null) {
						throw new RuntimeException(
							'Running-state commit failed and rollback failed: ' . $cleanupError,
							0,
							$stateError
						);
					}
					throw $stateError;
				}
			} elseif ($result === 0 || $result === '0') {
				error_log(date('M d H:i:s ') . 'ERROR: node start returned success but no local process was observed; stopping partial start');
				try {
					$cleanup = $this->deviceFactory->stop();
					if ($cleanup !== 0 && $cleanup !== '0') {
						error_log(date('M d H:i:s ') . 'ERROR: partial-start cleanup returned ' . (string) $cleanup);
					}
				} catch (Exception $e) {
					error_log(date('M d H:i:s ') . 'ERROR: partial-start cleanup failed: ' . $e->getMessage());
				}
				if (!$this->waitForLocalProcess(false)) {
					// Cleanup failed and a process is now visible: publish that truth so
					// remote status and quota accounting cannot undercount the orphan.
					$this->updateRunning($this->getSession(), '1', $this->getCpu(), $this->getRam());
					error_log(date('M d H:i:s ') . 'ERROR: partial-start process remains running after cleanup');
				}
				return 1;
			} elseif ($this->localProcessRunning()) {
				// A nonzero device result can still leave a partial process behind.
				// Clean up only because this invocation observed no process beforehand.
				try {
					$cleanup = $this->deviceFactory->stop();
					if ($cleanup !== 0 && $cleanup !== '0') {
						error_log(date('M d H:i:s ') . 'ERROR: failed-start cleanup returned ' . (string) $cleanup);
					}
				} catch (Exception $e) {
					error_log(date('M d H:i:s ') . 'ERROR: failed-start cleanup failed: ' . $e->getMessage());
				}
				if (!$this->waitForLocalProcess(false)) {
					$this->updateRunning($this->getSession(), '1', $this->getCpu(), $this->getRam());
					error_log(date('M d H:i:s ') . 'ERROR: failed-start process remains running after cleanup');
				}
			}
			return $result;
		} finally {
			$this->releaseRunningStartLock($pod);
		}
	}

	public function stop()
	{
		$result = $this->deviceFactory->stop();
		if (($result === 0 || $result === '0') && $this->waitForLocalProcess(false)) {
			$this->updateRunning($this->getSession(), '0', '0', '0');
		} elseif ($result === 0 || $result === '0') {
			error_log(date('M d H:i:s ') . 'WARNING: node stop returned success but the local process is still running');
			$result = 1;
		}
		return $result;
	}
	public function shutdown () {
		$this->deviceFactory->shutdown();
		if ($this->waitForLocalProcess(false)) {
			$this->updateRunning($this->getSession(), '0', '0', '0');
		}
	}

	public function isolate () {
			return $this->deviceFactory->isolate();
 	}
 	public function freeze () {
			return $this->deviceFactory->freeze();
 	}
	public function wipe()
	{
		$result = $this->deviceFactory->wipe();
		if (($result === 0 || $result === '0') && $this->waitForLocalProcess(false)) {
			$this->updateRunning($this->getSession(), '0', '0', '0');
		} elseif ($result === 0 || $result === '0') {
			error_log(date('M d H:i:s ') . 'WARNING: node wipe returned success but the local process is still running');
			$result = 1;
		}
		return $result;
	}
	public function hibernate () {
		 	$this->deviceFactory->hibernate();
		$result = $this->deviceFactory->stop();
		if (($result === 0 || $result === '0') && $this->waitForLocalProcess(false)) {
			$this->updateRunning($this->getSession(), '0', '0', '0');
		} elseif ($result === 0 || $result === '0') {
			error_log(date('M d H:i:s ') . 'WARNING: node hibernate returned success but the local process is still running');
			$result = 1;
		}
		return $result;
	}

	/**
	 * Method to link an interface.
	 * 
	 * @param   Array   $p                  Parameters
	 * @return  int                         0 means ok
	 */
	public function linkInterface($p, $hot = false)
	{
		if (!isset($p['id']) || (int) $p['id'] < 0) {
			throw new Exception('If ID is wrong');
		}
		$interfs = $this->getInterfaces();
		
		if (isset($interfs[$p['id']])) {
			$result = $interfs[$p['id']]->edit($p);
			if($hot) $interfs[$p['id']]->plug();
			return $result;
		}
		// throw new Exception('Non existent interface');
	}

	/** Create interface session data for node */
	public function addIfSessions(){
		if ($this->lab_session != null) {
			$interfs = $this->getInterfaces();
			foreach($interfs as $interf){
				$interf->addIfSession($this->lab_session, $this->session, $this->if_sessions);
			}
			
		}
	}

	/**
	 * Method to set config bin.
	 * 
	 * @param   string  $config_data         Binary config
	 * @return  int                         0 means ok
	 */
	public function setConfigData($config_data)
	{
		$this->deviceFactory->config_data = $config_data;
		// if($this->getActiveConfig()==''){
		// 	$this->updateStartUpConfig();
		// }
		return 0;
	}


	/**
	 * Method to update configuration to startup config
	 * Current no use
	 */

	public function updateStartUpConfig(){
		$startConfigFile = $this->getRunningPath() . '/startup-config';

		// root-side reset of startup-config + .configured; chowns the fresh
		// (empty) startup-config to www-data so the write below works
		broker_call('config_reset', [
			'lab_session' => (int) $this->lab_session,
			'node_session' => (int) $this->session,
		]);

		$activeConfig = $this->getActiveConfig();
		if ($activeConfig == '') {
			$config_data = $this->getConfigData();
		} else {
			$config_data = get($this->getMulti_config()[$activeConfig], '');
		}
		if(is_file($startConfigFile)){
			file_put_contents($startConfigFile, $config_data);
		}
		
		return true;
	}


	/**
	 * Return the node lock state as an integer (0 = unlocked, 1 = locked).
	 * Delegates to the device property; safe to call before the device is
	 * fully initialised (returns 0 on any error).
	 */
	public function getLock(): int
	{
		try {
			return isset($this->deviceFactory->lock) ? (int) $this->deviceFactory->lock : 0;
		} catch (Exception $e) {
			return 0;
		}
	}

	/**
	 * Return true when the node is locked (lock === 1).
	 */
	public function isLocked(): bool
	{
		return $this->getLock() === 1;
	}

	public function unlock(){
		$lockFile = $this->getRunningPath().'/.lock';
		if(is_file($lockFile)){
			broker_call('node_unlock', [
				'lab_session' => (int) $this->lab_session,
				'node_session' => (int) $this->session,
			]);
		}
		return true;
	}



	/**
	 * Method to unlink an interface.
	 * 
	 * @param   int     $i                  Interface ID
	 * @return  int                         0 means ok
	 */
	public function unlinkInterface($i, $hot = false)
	{
		if (!isset($i) || (int) $i < 0) {
			error_log(date('M d H:i:s ') . 'WARNING: ' . $GLOBALS['messages'][40017]);
			return 40017;
		}

		// Ethernet interface
		$ethernets = $this->getEthernets();
		if (isset($ethernets[$i])) {

			$qualityResult = $ethernets[$i]->unApplyQuality();
			if ($qualityResult !== 0) {
				throw new RuntimeException((string) $qualityResult);
			}
			$ethernets[$i]->removeQuality();
			$ethernets[$i]->removeSuspendStatus();

			if($hot) $ethernets[$i]->unplug();

			$result = $ethernets[$i]->edit(array('network_id' => ''));
	
			return $result;
		}

		// Serial interface
		$serials = $this->getSerials();
		if (isset($serials[$i])) {
			return $serials[$i]->edit(array('remote_id' => '', 'remote_if' => ''));
		}

		// Non existent interface
		error_log(date('M d H:i:s ') . 'WARNING: ' . $GLOBALS['messages'][40018]);
		return 40018;
	}
}
