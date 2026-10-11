#!/usr/bin/env php
<?php

require_once('/opt/unetlab/html/includes/init.php');
require_once('/opt/unetlab/html/includes/broker.php');
// Checking if called from CLI or Web
if (php_sapi_name() != 'cli') {
	error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][1]);
	exit(1);
}

// Checking privileges
if (posix_getuid() != 0) {
	error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][2]);
	exit(2);
}

// Setting umask
umask(0002);

// Parsing and checking parameters
$options = getopt('oT:D:S:F:a:i:');
//$options = getopt("oT:D:F:I:N:L:a:q:u:U:m:O:w:t:p:d:");

// Checking -a (action)
if (!isset($options['a'])) {
	usage();
	error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][3]);
	exit(3);
}
$action = $options['a'];

// Checking -T (Tenant ID)
if (in_array($action, array('delete', 'export', 'start', 'stop', 'wipe', 'shutdown','isolate','freeze'))) {
	if (!isset($options['T'])) {
		// Tenant ID is missing
		usage();
		error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][4]);
		exit(4);
	} else if ((int) $options['T'] < 0) {
		// Tenant ID is not valid
		usage();
		error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][5]);
		exit(5);
	} else {
		$tenant = (int) $options['T'];
	}
}
// Checking -S (Session ID)
if (isset($options['S'])) {
	if ((int) $options['S'] > 0) {
		$session_id = (int) $options['S'];
	} else {
		usage();
		error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][8]);
		exit(8);
	}
} else {
	$session_id = null;
}

// Checking -F (Lab file)
if (in_array($action, array('delete', 'export', 'start', 'stop', 'wipe'))) {
	if (!is_file($options['F'])) {
		// File not found
		usage();
		error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][6]);
		exit(6);
	}

	try {
		$lab = new Lab($options['F'], $tenant, $session_id);
	} catch (Exception $e) {
		// Lab file is invalid
		error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][$e->getMessage()]);
		error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][7]);
		exit(7);
	}
}

// Checking -D (Node ID)
if (isset($options['D'])) {
	if ((int) $options['D'] > 0 && isset($lab->getNodes()[$options['D']])) {
		$node_id = (int) $options['D'];
	} else {
		// Node ID must be numeric, greater than 0 and exists on lab
		usage();
		error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][8]);
		exit(8);
	}
}
if (in_array($action, ["ipv6"])) {
    if (!isset($options["i"])) {
        usage();
        exit;
    }
    $ipv6 = $options["i"];
}

switch ($action) {
	default:
		// Invalid action
		usage();
		error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][9]);
		exit(9);
	case 'delete':
		if (isset($node_id)) {
			// Removing temporary files for a single node in all tenants
			$nodeSessions = getAllSessionOfNode($lab->getId(), $node_id);
			foreach ($nodeSessions as $nodeSession) {
				$runningPath = $nodeSession['node_session_workspace'];
				if ($runningPath != null && $runningPath != '') {
					$cmd = 'rm -rf ' . $runningPath;
					error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $cmd);
					exec($cmd, $o, $rc);
				}
				if($nodeSession['node_session_type'] == 'docker'){
					$cmd = 'sudo /usr/bin/docker -H=unix:///var/run/docker.sock rm docker' . $nodeSession['node_session_id'];
					error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $cmd);
					exec($cmd, $o, $rc);
				}
			}
			// Orphan guard (docker-rebroker): the loop above resolves this node's
			// containers via a lab_sessions JOIN keyed on lab_session_lid, which
			// returns NOTHING when the .unl's id attribute has drifted from the
			// open session's lab_session_lid (lab file re-written / re-imported
			// while its session stayed open). apiDeleteLabNode() then drops the
			// node_sessions row by NUMERIC id (delNodeSession), so no later
			// destroy/sweep can ever find the container again — a permanent
			// orphan that blocks image deletion ("is in use by running lab
			// node(s): dockerN"). Remove THIS session's container by its numeric
			// node-session id too. Idempotent: rc!=0 when the loop above (or a
			// prior wipe) already removed it. force=true because the lid drift
			// also blinds the running-node guard in apiDeleteLabNode(), so the
			// container may still be running here.
			if (isset($lab->getNodes()[$node_id])
				&& $lab->getNodes()[$node_id]->getNType() == 'docker'
				&& function_exists('broker_docker_rm')) {
				$orphan_ns = (int) $lab->getNodes()[$node_id]->getSession();
				if ($orphan_ns > 0) {
					broker_docker_stop($orphan_ns);
					broker_docker_rm($orphan_ns, true);
				}
			}
		} else {
			// Removing all temporary files in all tenants
			$cmd = 'rm -rf ' . BASE_TMP . '/' . $lab->getSession();
		}

		break;
	case 'export':
		// Exporting node(s) running-config
		set_time_limit(0);
		if (isset($node_id)) {
			// Node ID is set, export a single node
			$rc = export($lab->getNodes()[$node_id], $lab, $lab->getTenant());
			if ($rc == 80061 || $rc == 80084) {
				error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][19]);
				exit(19);
			}
			if ($rc !== 0) {
				// Failed to export config
				error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][16]);
				exit(16);
			}
		} else {
			// Node ID is not set, export all nodes
			foreach ($lab->getNodes() as $node_id => $node) {
				export($node, $lab, $lab->getTenant());
			}
		}
		break;
	case 'fixpermissions':
	
		// /opt/unetlab/scripts
		$cmd = '/bin/chmod 755 -R /opt/unetlab/scripts > /dev/null 2>&1';
		exec($cmd, $o, $rc);
		
		// /opt/unetlab/data and /opt/unetlab/labs
		$cmd = '/bin/chown -R www-data:www-data /opt/unetlab/data /opt/unetlab/labs > /dev/null 2>&1';
		exec($cmd, $o, $rc);

		// external-auth secrets (RADIUS shared secret + LDAP bind password) must
		// stay root-only: the broker reads them, www-data never does. Re-assert
		// after the data sweep above, which would otherwise hand them to www-data.
		$cmd = '/bin/chown -R root:root /opt/unetlab/data/extauth > /dev/null 2>&1; /bin/chmod 700 /opt/unetlab/data/extauth > /dev/null 2>&1; /bin/chmod 600 /opt/unetlab/data/extauth/config.json > /dev/null 2>&1';
		exec($cmd, $o, $rc);

		// /opt/unetlab/tmp
		$cmd = '/bin/chown -R root:unl /opt/unetlab/tmp > /dev/null 2>&1';
		exec($cmd, $o, $rc);
		$cmd = '/bin/chmod -R 777 /opt/unetlab/tmp > /dev/null 2>&1';
		exec($cmd, $o, $rc);

		$cmd = '/bin/chmod 777 /tmp > /dev/null 2>&1';
		exec($cmd, $o, $rc);

		exec($cmd, $o, $rc);
		$cmd = 'sudo /bin/chown -R root:unl /opt/unetlab/users > /dev/null 2>&1';
		exec($cmd, $o, $rc);
		$cmd = 'sudo /bin/chmod -R 2775 /opt/unetlab/users > /dev/null 2>&1';
		exec($cmd, $o, $rc);

		// /opt/unetlab/addons/iol/bin
		$cmd = '/bin/chmod -R 755 /opt/unetlab/addons > /dev/null 2>&1';
		exec($cmd, $o, $rc);

		// Wrappers
		$cmd = '/bin/chmod 755 /opt/unetlab/wrappers/nsenter /opt/unetlab/wrappers/*_wrapper*  /opt/unetlab/wrappers/bash-static /opt/unetlab/wrappers/busybox /opt/unetlab/wrappers/profile.sh > /dev/null 2>&1';
		exec($cmd, $o, $rc);
		$cmd = 'sudo /bin/chmod -R 777 /opt/unetlab/html/store > /dev/null 2>&1';
		exec($cmd, $o, $rc);
		// /tmp
		$cmd = '/bin/chown root:root /tmp 2>&1';
		exec($cmd, $o, $rc);
		$cmd = '/bin/chmod u=rwx,g=rwx,o=rwxt /tmp > /dev/null 2>&1';
		exec($cmd, $o, $rc);

		$cmd = 'chown -R www-data:www-data /opt/unetlab/html > /dev/null 2>&1';
		exec($cmd, $o, $rc);

		$cmd = 'chmod -R 755 /opt/unetlab/html > /dev/null 2>&1';
		exec($cmd, $o, $rc);

		break;
	case 'stopall':
		// Kill all nodes and clear the system
		$cmd = 'pkill -TERM dynamips > /dev/null 2>&1';
		exec($cmd, $o, $rc);
		$cmd = 'pkill -TERM iol_wrapper > /dev/null 2>&1';
		exec($cmd, $o, $rc);
		$cmd = 'pkill -TERM qemu* > /dev/null 2>&1';
		exec($cmd, $o, $rc);
		$cmd = 'pkill -TERM vpcs > /dev/null 2>&1';
		exec($cmd, $o, $rc);
		$cmd = 'docker -H=unix:///var/run/docker.sock stop $(docker -H=unix:///var/run/docker.sock ps -q)';
		exec($cmd, $o, $rc);
		$cmd = 'brctl show | grep vnet | sed \'s/^\(vnet[0-9]\+_[0-9]\+\).*/\1/g\' | while read line; do ifconfig $line down; brctl delbr $line; done';
		exec($cmd, $o, $rc);
		$cmd = 'brctl show | grep internal | sed \'s/^\(internal[0-9]\+_[0-9]\+\).*/\1/g\' | while read line; do ifconfig $line down; brctl delbr $line; done';
        exec($cmd, $o, $rc);
        $cmd = 'brctl show | grep private | sed \'s/^\(private[0-9]\+_[0-9]\+\).*/\1/g\' | while read line; do ifconfig $line down; brctl delbr $line; done';
        exec($cmd, $o, $rc);
		$cmd = 'ovs-vsctl list-br | while read line; do ovs-vsctl del-br $line; done';
		exec($cmd, $o, $rc);
		$cmd = 'ifconfig | grep vunl | cut -d\' \' -f1 | while read line; do tunctl -d $line; done';
		exec($cmd, $o, $rc);
		$cmd = 'ifconfig | grep ser | cut -d\' \' -f1 | while read line; do tunctl -d $line; done';
		exec($cmd, $o, $rc);
		$cmd = 'find /opt/unetlab/labs/ -name "*.lock" -exec rm -f {} \;';
		exec($cmd, $o, $rc);
		break;
	   case "platform":
        $cmd = "(egrep vmx /proc/cpuinfo | grep -q ept && echo vmx )";
        exec($cmd, $o, $rc);
        $cmd = "/usr/sbin/dmidecode -s system-product-name";
        exec($cmd, $o, $rc);
        echo implode("", $o) . "\n";
        break;
	case 'start':
		// Starting node(s)

		// if (!checkUsername($lab->getTenant())) {
		// 	error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][14]);
		// 	exit(14);
		// }

			
		if (isset($node_id)) {
			
			//NAJIB
			    foreach ($lab->getNodes()[$node_id]->getEthernets() as $interface) {
                if ($interface->getNetworkId() !== 0 && !isset($lab->getNetworks()[$interface->getNetworkId()])) {
                    error_log(date("M d H:i:s ") . date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][10]);
                    exit(10);
                }
                     if ($interface->getNetworkId() !== 0) {
                    $type = $lab->getNetworks()[$interface->getNetworkId()]->getNType();
                    switch ($type) {
                        case "internal":
                        case "internal2":
                        case "internal3":
                            $netname = $type . "_" . $lab->getSession();
                            $p = ["name" => $netname, "type" => $lab->getNetworks()[$interface->getNetworkId()]->getNType(), "count" => $lab->getNetworks()[$interface->getNetworkId()]->getCount()];
                            $rc = addNetwork($p);
                            break;
                        case "private":
                        case "private2":
                        case "private3":
                            $netname = $type . "_" . $lab->gethost();
                            $p = ["name" => $netname, "type" => $lab->getNetworks()[$interface->getNetworkId()]->getNType(), "count" => $lab->getNetworks()[$interface->getNetworkId()]->getCount()];
                            $rc = addNetwork($p);
                            break;
                        default:
                            $netname = 'vnet'. $lab->getSession().'_'.$interface -> getNetworkId();
                            $p = ["name" => $netname, "type" => $lab->getNetworks()[$interface->getNetworkId()]->getNType(), "count" => $lab->getNetworks()[$interface->getNetworkId()]->getCount()];
                            $rc = addNetwork($p);
                            if ($rc !== 0) {
                                error_log(date("M d H:i:s ") . date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][$rc]);
                                error_log(date("M d H:i:s ") . date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][11]);
                                exit(11);
                            }
                    }
                }

            }         
			

			// Starting the node
			$rc = start($lab, $node_id);
			if ($rc !== 0) {
				// Failed to start the node
				error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][$rc]);
				error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][12]);
				exit(12);
			}
		} else {
			// Node ID is not set, start all nodes
			// Create all networks
			foreach ($lab->getNetworks() as $network_id => $network) {
				$p = array(
					'name' => 'vnet' . $lab->getSession() . '_' . $network_id,
					'type' => $network->getNType()
				);
				$rc = addNetwork($p);
				if ($rc !== 0) {
					// Failed to create network
					error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][$rc]);
					error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][11]);
					exit(11);
				}
			}

			// Starting all non-IOL nodes
			foreach ($lab->getNodes() as $node_id => $node) {
				if ($node->getNType() != 'iol') {
					// IOL nodes drop privileges, so need to be postponed
					$rc = start($node, $node_id, $tenant, $lab->getNetworks(), $lab->getScriptTimeout());
					if ($rc !== 0) {
						// Failed to start the node
						error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][$rc]);
						error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][12]);
						exit(12);
					}
				}
			}

			// Starting all IOL nodes
			foreach ($lab->getNodes() as $node_id => $node) {
				if ($node->getNType() == 'iol') {
					// IOL nodes drop privileges, so need to be postponed
					$rc = start($lab, $node_id, $tenant);
					if ($rc !== 0) {
						// Failed to start the node
						error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][$rc]);
						error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][12]);
						exit(12);
					}
				}
			}
		}
		break;
	case 'stop':
		// Stopping node(s)
		if (isset($node_id)) {
			$result = stop($lab->getNodes()[$node_id]);
			if ($result != 0) exit($result);
		
		} else {
			foreach ($lab->getNodes() as $node) {
				$result = stop($node); 
				if ($result != 0) exit($result);
				

			}
		}
		break;

    case "ipv6":
        $cmd = "sysctl -w net.ipv6.conf.wlan0.disable_ipv6=" . ($ipv6 == 1 ? 0 : 1);
        shell_exec($cmd);
        $cmd = "sed -i /etc/gai.conf -e 's,.*precedence ::ffff:0:0/96  100.*," . ($ipv6 == 1 ? "#precedence ::ffff:0:0/96  100" : "precedence ::ffff:0:0/96  100") . ",'";
        shell_exec($cmd);
        break;
	case "backupdb":
        shell_exec("mysqldump -uroot -ppnetlab --add-drop-database --skip-comments  --databases pnetlab_db > /opt/unetlab/database_backup/pnetlab_db.sql ; mysqldump -uroot -ppnetlab --add-drop-database --skip-comments  --databases guacdb > /opt/unetlab/database_backup/guacdb.sql");
        break;
    case "restoredb":
        shell_exec("cat /opt/unetlab/database_backup/pnetlab_db.sql | /usr/bin/mysql --password=pnetlab pnetlab_db ; cat /opt/unetlab/database_backup/guacdb.sql | /usr/bin/mysql --password=pnetlab guacdb");
        break;
	case 'wipe':
		// Removing temporary files
		if ($session_id == null) return;
		if (isset($node_id)) {
			$node = $lab->getNodes()[$node_id];
			$result = stop($node);
			if ($result != 0) exit($result);
			// Delete Docker image
			$result = wipe($node);
			if ($result != 0) exit($result);
		} else {
			// Node ID is not set, stop and wipe all nodes
			foreach ($lab->getNodes() as $node_id => $node) {
				$result = stop($node);
				if ($result != 0) exit($result);
				// Delete Docker image
				$result = wipe($node);
				if ($result != 0) exit($result);
			}
		}
		break;

	case 'cpulimitoff':
		$policy = broker_qemu_cpu_policy(false);
		if (empty($policy['ok'])) {
			error_log(date('M d H:i:s ') . 'ERROR: failed to disable QEMU CPU capping: ' .
				(isset($policy['err']) ? $policy['err'] : 'broker error'));
			exit(13);
		}
		break;
	case 'cpulimiton':
		$policy = broker_qemu_cpu_policy(true);
		if (empty($policy['ok'])) {
			error_log(date('M d H:i:s ') . 'ERROR: failed to enable QEMU CPU capping: ' .
				(isset($policy['err']) ? $policy['err'] : 'broker error'));
			exit(13);
		}
		break;
	case 'uksmoff':
		$cmd = 'sudo echo 0 > /sys/kernel/mm/uksm/run';
		exec($cmd, $o, $rc);
		if ($rc !== 0) {
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][13]);
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . implode("\n", $o));
			exit(13);
		}
		$cmd = 'sudo echo 0 > /opt/unetlab/uksm';
		exec($cmd, $o, $rc);
		if ($rc !== 0) {
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][13]);
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . implode("\n", $o));
			exit(13);
		}
		break;
	case 'uksmon':
		$cmd = 'sudo echo 1 > /sys/kernel/mm/uksm/run';
		exec($cmd, $o, $rc);
		if ($rc !== 0) {
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][13]);
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . implode("\n", $o));
			exit(13);
		}
		$cmd = 'echo 1 > /opt/unetlab/uksm';
		exec($cmd, $o, $rc);
		if ($rc !== 0) {
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][13]);
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . implode("\n", $o));
			exit(13);
		}
		break;
	case 'ksmoff':
		$cmd = 'sudo echo 0 > /sys/kernel/mm/ksm/run';
		exec($cmd, $o, $rc);
		if ($rc !== 0) {
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][13]);
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . implode("\n", $o));
			exit(13);
		}
		$cmd = 'sudo echo 0 > /opt/unetlab/ksm';
		exec($cmd, $o, $rc);
		if ($rc !== 0) {
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][13]);
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . implode("\n", $o));
			exit(13);
		}
		break;
	case 'ksmon':
		$cmd = 'sudo echo 1 > /sys/kernel/mm/ksm/run';
		exec($cmd, $o, $rc);
		if ($rc !== 0) {
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][13]);
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . implode("\n", $o));
			exit(13);
		}
		$cmd = 'sudo echo 1 > /opt/unetlab/ksm';
		exec($cmd, $o, $rc);
		if ($rc !== 0) {
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][13]);
			error_log(date('M d H:i:s ') . date('M d H:i:s ') . implode("\n", $o));
			exit(13);
		}
		break;
}
exit(0);
?>
