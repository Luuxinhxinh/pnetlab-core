<?php
# vim: syntax=php tabstop=4 softtabstop=0 noexpandtab laststatus=1 ruler

/**
 * html/includes/cli.php
 *
 * Various functions for UNetLab CLI handler.
 *
 * @author Andrea Dainese <andrea.dainese@gmail.com>
 * @copyright 2014-2016 Andrea Dainese
 * @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
 * @link http://www.unetlab.com/
 * @version 20160719
 */

require_once(__DIR__ . '/broker.php');

/**
 * Function to create a bridge
 *
 * @param   string  $s                  Bridge name
 * @return  int                         0 means ok
 */
function addBridge($s) {
	// B7: the web context (www-data) has no sudo, and a setcap'd /bin/ip
	// is useless — iproute2 drops file capabilities for everything except
	// "ip vrf exec". Without root the bridge is created but left
	// admin-DOWN with group_fwd_mask 0: every port sits in "state
	// disabled", nothing forwards (no CDP/STP/LACP) and both attached
	// switches elect themselves STP root. The broker's net_create does
	// the whole create + ipv6-off + group_fwd_mask 65535 (65528 stock
	// fallback) + mcast_snooping 0 + link-up as root, idempotently —
	// re-running it also heals a bridge an older engine left broken.
	$resp = broker_call('net_create', array(
		'name' => $s['name'],
		'ageing0' => (isset($s['count']) && $s['count'] < 3) ? 1 : 0));
	if (!$resp['ok'] || $resp['rc'] != 0) {
		// Failed to add the bridge
		error_log(date('M d H:i:s ').'ERROR: '.$GLOBALS['messages'][80026]);
		error_log(date('M d H:i:s ').$resp['err'].' '.implode("\n", $resp['out']));
		return 80026;
	}
	return 0;
}

/**
 * Function to stop a node.
 *
 * @param   Array   $p                  Parameters
 * @return  int                         0 means ok
 */
function addNetwork($p) {
	if (!isset($p['name']) || !isset($p['type'])) {
		// Missing mandatory parameters
		error_log(date('M d H:i:s ').'ERROR: '.$GLOBALS['messages'][80021]);
		return 80021;
	}

	switch ($p['type']) {
		default:
			if (in_array($p['type'], listClouds())) {
				// Cloud already exists
			} else if (preg_match('/^pnet[0-9]+$/', $p['type']) || preg_match('/^nat[0-9]+$/', $p['type']) ) {
				// Cloud does not exist
				error_log(date('M d H:i:s ').'ERROR: '.$GLOBALS['messages'][80056]);
				return 80056;
			} else {
				// Should not be here
				error_log(date('M d H:i:s ').'ERROR: '.$GLOBALS['messages'][80020]);
				return 80020;
			}
			break;
		case 'dot1q':
			// dot1q switch: a lab bridge with vlan_filtering on, so per-port
			// access/trunk VLANs (interfc.php applyVlan -> broker iface_vlan)
			// take effect. addBridge() heals an existing bridge idempotently.
			if (isOvs($p['name'])) {
				$rc = delOvs($p['name']);
				if ($rc != 0) return $rc;
			}
			$rc = addBridge($p);
			if ($rc != 0) return $rc;
			$resp = broker_call('net_create', array(
				'name' => $p['name'],
				'vlan_filtering' => 1,
				'default_pvid' => 1));
			if (!$resp['ok'] || $resp['rc'] != 0) {
				error_log(date('M d H:i:s ').'ERROR: dot1q vlan_filtering on '.$p['name'].' failed: '.$resp['err']);
				return 80026;
			}
			return 0;
			break;
		case 'router':
			// soft-router: a normal lab bridge PLUS a per-network Linux netns
			// L3 gateway (NAT/DHCP/static routes) built by the broker. The
			// full config is pushed from the Configure dialog (api.php ->
			// router_apply); router_create stands up the netns skeleton and
			// auto-restores any persisted config at lab start.
			if (isOvs($p['name'])) {
				$rc = delOvs($p['name']);
				if ($rc != 0) return $rc;
			}
			$rc = addBridge($p);
			if ($rc != 0) return $rc;
			$rid = routerIds($p['name']);
			if ($rid === false) return 0;
			$resp = broker_call('router_create', $rid);
			if (!$resp['ok'] || $resp['rc'] != 0) {
				error_log(date('M d H:i:s ').'ERROR: router_create on '.$p['name'].' failed: '.$resp['err']);
				return 80026;
			}
			return 0;
			break;
		case 'wireless':
			// Wireless cell (P1c → VLAN-trunk multi-SSID): an RF domain that hosts ONE OR
			// MORE SSIDs, each mapped to a VLAN. Backed by a vlan_filtering lab bridge — the
			// SAME plumbing as the dot1q switch — so the cell doubles as the VLAN-aware
			// switch and the two concepts unify. The AP cables in on a single TRUNK port
			// carrying every SSID's VLAN (AP runs hostapd multi-BSS, one BSS per SSID bridged
			// to a VLAN sub-interface of the trunk); wired lab nodes (router/DHCP/RADIUS)
			// attach on per-VLAN ACCESS ports (the standard per-interface VLAN UI applies now
			// that the cell filters VLANs). The untagged/native VLAN = AP management. The
			// cell's WLAN list (SSID+VLAN+security) is held broker-side (wifi_cell_apply/get)
			// and baked into the AP's hostapd multi-BSS config at start. A single-SSID cell
			// with no VLANs still behaves like the old transparent L2 segment (default_pvid 1).
			if (isOvs($p['name'])) {
				$rc = delOvs($p['name']);
				if ($rc != 0) return $rc;
			}
			$rc = addBridge($p);
			if ($rc != 0) return $rc;
			$resp = broker_call('net_create', array(
				'name' => $p['name'],
				'vlan_filtering' => 1,
				'default_pvid' => 1));
			if (!$resp['ok'] || $resp['rc'] != 0) {
				error_log(date('M d H:i:s ').'ERROR: wireless cell vlan_filtering on '.$p['name'].' failed: '.$resp['err']);
				return 80026;
			}
			return 0;
			break;
		case 'bridge':
			if (!isInterface($p['name'])) {
				// Interface does not exist -> create bridge
				return addBridge($p);
			} else if (isBridge($p['name'])) {
				// Bridge already present
				return 0;
			} else if (isOvs($p['name'])) {
				// OVS exists -> delete it and add bridge
				$rc = delOvs($p['name']);
				if ($rc == 0) {
					// OVS deleted, create the bridge
					return addBridge($p);
				} else {
					// Failed to delete OVS
					return $rc;
				}
			} else {
				// Non bridge/OVS interface exist -> cannot create
				error_log(date('M d H:i:s ').'ERROR: '.$GLOBALS['messages'][80022]);
				return 80022;
			}
			break;
			case "internal":
	                case "internal2":
	                case "internal3":             
	                case "private":
	                case "private2":
	                case "private3":
	                error_log(date('M d H:i:s ') . 'INFO: Add network bridge ' . $p['name']);
			return addBridge($p);
			break;
		case 'ovs':
			if (!isInterface($p['name'])) {
				// Interface does not exist -> create OVS
				return addOvs($p['name']);
			} else if (isOvs($p['name'])) {
				// OVS already present
				return 0;
			} else if (isBridge($p['name'])) {
				// Bridge exists -> delete it and add OVS
				$rc = delBridge($p['name']);
				if ($rc == 0) {
					// Bridge deleted, create the OVS
					return addOvs($p['name']);
				} else {
					// Failed to delete Bridge
					return $rc;
				}
			} else {
				// Non bridge/OVS interface exist -> cannot create
				error_log(date('M d H:i:s ').'ERROR: '.$GLOBALS['messages'][80022]);
				return 80022;
			}
			break;
	}
	return 0;
}

/*
 * Function to create an OVS
 *
 * @param   string  $s                  OVS name
 * @return  int                         0 means ok
 */
function addOvs($s)
{
	$s = secureIdent($s, "name");
	$cmd = 'ovs-vsctl add-br ' . $s . ' 2>&1';
	exec($cmd, $o, $rc);
	if ($rc != 0) {
		// Failed to add the OVS
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80023]);
		error_log(date('M d H:i:s ') . implode("\n", $o));
		return 80023;
	}
	// ADD BPDU CDP option
	$cmd = "ovs-vsctl set bridge " . $s . " other-config:forward-bpdu=true";
	exec($cmd, $o, $rc);
	if ($rc == 0) {
		return 0;
	} else {
		// Failed to add  OVS OPTION
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80023]);
		error_log(date('M d H:i:s ') . implode("\n", $o));
		return 80023;
	}
}

/**
 * Function to create a TAP interface
 *
 * @param   string  $s                  Network name
 * @return  int                         0 means ok
 */
function addTap($s, $u , $mtu)
{
	$s = secureIdent($s, "name");
	$u = secureIdent($u, "name");
	// TODO if already exist should fail?
	$cmd = 'sudo tunctl -u ' . $u . ' -g root -t ' . $s . ' 2>&1';
	error_log(date('M d H:i:s ') . 'INFO: ' . $cmd);
	exec($cmd, $o, $rc);
	if ($rc != 0) {
		// Failed to add the TAP interface
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80032]);
		error_log(date('M d H:i:s ') . implode("\n", $o));
		return 80032;
	}

	$cmd = 'sudo sysctl -w net.ipv6.conf.' . $s . '.disable_ipv6=1';
	error_log(date('M d H:i:s ') . 'INFO: ' . $cmd);
	exec($cmd, $o, $rc);
	if ($rc != 0) {
		// Failed to disable IPV6 
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80089]);
		error_log(date('M d H:i:s ') . implode("\n", $o));
		return 80089;
	}

	$cmd = 'sudo ip link set dev ' . $s . ' up 2>&1';
	exec($cmd, $o, $rc);
	if ($rc != 0) {
		// Failed to activate the TAP interface
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80033]);
		error_log(date('M d H:i:s ') . implode("\n", $o));
		return 80033;
	}

	$cmd = 'sudo ip link set dev ' . $s . ' mtu ' . $mtu;
	error_log(date('M d H:i:s ') . 'INFO: ' . $cmd);
	exec($cmd, $o, $rc);
	if ($rc != 0) {
		// Failed to activate the TAP interface
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80085]);
		error_log(date('M d H:i:s ') . implode("\n", $o));
		return 80085;
	}

	return 0;
}

/**
 * Function to check if a tenant has a valid username.
 *
 * @param   int     $i                  Tenant ID
 * @return  bool                        True if valid
 */
function checkUsername($i)
{
	$i = secureIdent($i, "tenant id");
	if ((int) $i < 0) {
		// Tenand ID is not valid
		return False;
	} else {
		// Just to be sure
		$i = (int) $i;
	}

	if (!is_dir('/opt/unetlab/users')) {
		$cmd = 'mkdir /opt/unetlab/users > /dev/null 2>&1';
		exec($cmd, $o, $rc);
		$cmd = '/bin/chown -R root:unl /opt/unetlab/users > /dev/null 2>&1';
		exec($cmd, $o, $rc);
		$cmd = '/bin/chmod -R 2775 /opt/unetlab/users > /dev/null 2>&1';
		exec($cmd, $o, $rc);
	}

	$path = '/opt/unetlab/users/' . $i;
	$uid = 32768 + $i;

	$cmd = 'id unl' . $i . ' 2>&1';
	exec($cmd, $o, $rc);
	if ($rc != 0) {
		// Need to add the user
		$cmd = 'sudo /usr/sbin/useradd -c "Unified Networking Lab TID=' . $i . '" -d ' . $path . ' -g unl -M -s /bin/bash -u ' . $uid . ' unl' . $i . ' 2>&1';
		error_log(date('M d H:i:s ') . 'ERROR: ' . $cmd);
		exec($cmd, $o, $rc);
		if ($rc != 0) {
			// Failed to add the username
			error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80009]);
			error_log(date('M d H:i:s ') . implode("\n", $o));
			return False;
		}
	}

	// Now check if the home directory exists
	if (!is_dir($path) && !mkdir($path, 2755, true)) {
		// Failed to create the home directory
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80010]);
		return False;
	}

	// Be sure of the setgid bit
	if ($rc != 0) {
		// Failed to set the setgid bit
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80011]);
		error_log(date('M d H:i:s ') . implode("\n", $o));
		return False;
	}

	// Set permissions
	if (!chown($path, 'unl' . $i)) {
		// Failed to set owner and/or group
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80012]);
		return False;
	}

	// Last, link the profile
	if (!file_exists($path . '/.profile') && !symlink('/opt/unetlab/wrappers/unl_profile', $path . '/.profile')) {
		// Failed to link the profile
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80013]);
		return False;
	}

	return True;
}

/**
 * Function to connect an interface (TAP) to a network (Bridge/OVS)
 *
 * @param   string  $n                  Network name
 * @param   string  $p                  Interface name
 * @return  int                         0 means ok
 */
function connectInterface($n, $p)
{
	$n = secureIdent($n, "name");
	$p = secureIdent($p, "name");
	if (isBridge($n)) {
		$cmd = 'brctl addif ' . $n . ' ' . $p . ' 2>&1';
		error_log(date('M d H:i:s ') . $cmd);
		exec($cmd, $o, $rc);
		if ($rc == 0) {
			return 0;
		} else {
			// Failed to add interface to Bridge
			error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80030]);
			error_log(date('M d H:i:s ') . implode("\n", $o));
			return 80030;
		}
	} else if (isOvs($n)) {
		$cmd = 'ovs-vsctl add-port ' . $n . ' ' . $p . ' 2>&1';
		exec($cmd, $o, $rc);
		if ($rc == 0) {
			return 0;
		} else {
			// Failed to add interface to OVS
			error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80031]);
			error_log(date('M d H:i:s ') . implode("\n", $o));
			return 80031;
		}
	} else {
		// Network not found
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80029]);
		return 80029;
	}
}


function disconnectInterface($n, $p)
{
	$n = secureIdent($n, "name");
	$p = secureIdent($p, "name");
	if (isBridge($n)) {
		$cmd = 'brctl delif ' . $n . ' ' . $p . ' 2>&1';
		
		error_log(date('M d H:i:s ') . $cmd);
		exec($cmd, $o, $rc);
		
		if ($rc == 0) {
			return 0;
		} else {
			// Failed to add interface to Bridge
			error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80030]);
			error_log(date('M d H:i:s ') . implode("\n", $o));
			return 80030;
		}
	} else if (isOvs($n)) {
		$cmd = 'ovs-vsctl del-port ' . $n . ' ' . $p . ' 2>&1';
		exec($cmd, $o, $rc);
		if ($rc == 0) {
			return 0;
		} else {
			// Failed to add interface to OVS
			error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80031]);
			error_log(date('M d H:i:s ') . implode("\n", $o));
			return 80031;
		}
	} else {
		// Network not found
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80029]);
		return 80029;
	}
}

/**
 * Parse a lab bridge name "vnet<session>_<netid>" into the broker's
 * session/net_id args. Returns false for cloud/non-lab bridges.
 *
 * @param   string  $name               Bridge name
 * @return  array|false                 ['session'=>int,'net_id'=>int] or false
 */
function routerIds($name) {
	if (preg_match('/^vnet(\d+)_(\d+)$/', $name, $m)) {
		return array('session' => intval($m[1]), 'net_id' => intval($m[2]));
	}
	return false;
}

/**
 * Function to delete a bridge
 *
 * @param   string  $s                  Bridge name
 * @return  int                         0 means ok
 */
function delBridge($s)
{
	$s = secureIdent($s, "name");
	// soft-router teardown: harmless no-op for non-router vnet bridges (the
	// broker checks for a netns/state). Runs before net_delete so the netns
	// and its enslaved veths go away cleanly.
	$rid = routerIds($s);
	if ($rid !== false) {
		broker_call('router_delete', $rid);
		// wireless cell: drop any per-run WLAN state (no-op for non-cell nets).
		broker_call('wifi_cell_delete', $rid);
	}
	// Need to deactivate it
	if (preg_match('/^pnet[\d\w]+$/', $s) ||  preg_match('/^nat[0-9]+$/', $s)) {
				// Cloud does not exist
			} 
	/*elseif (preg_match("/private(.*)/", $s)) {
				// Cloud does not exist
			} 
	elseif (preg_match("/internal(.*)/", $s)) {
				// Cloud does not exist
			} */

	/*------------------------------ NOT KILL NETWORK BEGIN WITH INTERNAL PRIVATE---------------------------------------------------------------------------------*/


	else {
	// B7: down+delete need root (see addBridge); net_delete only accepts
	// vnet<session>_<id> names, so cloud bridges cannot reach it anyway.
	$resp = broker_call('net_delete', array('name' => $s));
	if ($resp['ok'] && $resp['rc'] == 0) {
		return 0;
	} else {
		// Failed to delete the bridge
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80025]);
		error_log(date('M d H:i:s ') . $resp['err'] . ' ' . implode("\n", $resp['out']));
		return 80025;
	}
			}
	

}

/**
 * Function to delete an OVS
 *
 * @param   string  $s                  OVS name
 * @return  int                         0 means ok
 */
function delOvs($s)
{
	$s = secureIdent($s, "name");
	$cmd = 'ovs-vsctl del-br ' . $s . ' 2>&1';
	exec($cmd, $o, $rc);
	if ($rc == 0) {
		return 0;
	} else {
		// Failed to delete the OVS
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80024]);
		error_log(date('M d H:i:s ') . implode("\n", $o));
		return 80024;
	}
}

/**
 * Function to delete a TAP interface
 *
 * @param   string  $s                  Interface name
 * @return  int                         0 means ok
 */
function delTap($s)
{
	$s = secureIdent($s, "name");
	if (isInterface($s)) {
		// Remove interface from OVS switches
		$cmd = 'ovs-vsctl del-port ' . $s . ' 2>&1';
		exec($cmd, $o, $rc);

		// B7: deleting the link needs root (see addBridge); removal from
		// any bridge is implicit in the link delete.
		broker_call('tap_delete', array('name' => $s));

		if (isInterface($s)) {
			// Failed to delete the TAP interface
			error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80034]);
			error_log(date('M d H:i:s ') . implode("\n", $o));
			return 80034;
		} else {
			return 0;
		}
	} else {
		// Interface does not exist
		return 0;
	}
}

/**
 * Function to push startup-config to a file
 *
 * @param   string  $config_data        The startup-config
 * @param   string  $file_path          File with full path where config is stored
 * @return  bool                        true if config dumped
 */
function dumpConfig($config_data, $file_path)
{
	$fp = fopen($file_path, 'w');
	if (!isset($fp)) {
		// Cannot open file
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80068]);
		return False;
	}

	if (!fwrite($fp, $config_data)) {
		// Cannot write file
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][80069]);
		return False;
	}

	return True;
}

/**
 * Function to export a node running-config.
 *
 * @param   int     $node_id            Node ID
 * @param   Node    $n                  Node
 * @param   Lab     $lab                Lab
 * @return  int                         0 means ok
 */
function export($n, $lab)
{
	
	$result = $n->export();
	if($result != 0) return $result;

	$lab->save();
	
	return 0;
}

/**
 * Function to check if a bridge exists
 *
 * @param   string  $s                  Bridge name
 * @return  bool                        True if exists
 */
function isBridge($s)
{
	$s = secureIdent($s, "name");
	$cmd = 'brctl show ' . $s . ' 2>&1';
	exec($cmd, $o, $rc);
	if (preg_match('/8000/', $o[1])) {
		// "brctl show" on a ovs bridge or on a non-existent bridge return 0 -> check for 8000
		return True;
	} else {
		return False;
	}
}

/**
 * Function to check if a interface exists
 *
 * @param   string  $s                  Interface name
 * @return  bool                        True if exists
 */
function isInterface($s)
{
	$s = secureIdent($s, "name");
	$cmd = 'ip link show ' . $s . ' 2>&1';
	exec($cmd, $o, $rc);
	if ($rc == 0) {
		return True;
	} else {
		return False;
	}
}

function isInterfaceUp($s)
{
	$s = secureIdent($s, "name");
	$cmd = 'ip link show ' . $s . ' | grep UP';
	exec($cmd, $o, $rc);
	if(count($o) > 0) return true;
	return false;
}

function isInterfaceDown($s)
{
	$s = secureIdent($s, "name");
	$cmd = 'ip link show ' . $s . ' | grep DOWN';
	exec($cmd, $o, $rc);
	if(count($o) > 0) return true;
	return false;
}

/**
 * Function to check if an OVS exists
 *
 * @param   string  $s                  OVS name
 * @return  bool                        True if exists
 */
function isOvs($s)
{
	$s = secureIdent($s, "name");
	$cmd = 'ovs-vsctl br-exists ' . $s . ' 2>&1';
	exec($cmd, $o, $rc);
	if ($rc == 0) {
		return True;
	} else {
		return False;
	}
}

/**
 * Function to check if a node is running.
 *
 * @param   int     $p                  Port
 * @return  bool                        true if running
 */
function isRunning($p)
{
	$p = secureIdent($p, "port");
	// If node is running, the console port is used
	$cmd = 'fuser -n tcp ' . $p . ' 2>&1';
	exec($cmd, $o, $rc);
	if ($rc == 0) {
		return True;
	} else {
		return False;
	}
}

/**
 * Function to check if a TAP interface exists
 *
 * @param   string  $s                  Interface name
 * @return  bool                        True if exists
 */
function isTap($s)
{
	$s = secureIdent($s, "name");
	if (is_dir('/sys/class/net/' . $s)) {
		// TODO can be bridge or OVS
		return True;
	} else {
		return False;
	}
}


/**
 * Function to start a node.
 *
 * @param   Node    $n                  Node
 * @param   Int     $id                 Node ID
 * @param   Int     $t                  Tenant ID
 * @param   Array   $nets               Array of networks
 * @param   int     $scripttimeout      Config Script Timeout
 * @return  int                         0 means ok
 */
function start($lab, $id)
{
	$n = $lab->getNodes()[$id];
	$t = $lab->getHost();
	if($t === null) return 1;
		// Start a node that is STOPPED, whether or not it is locked:
		//   0 = stopped, 1 = stopped + LOCKED, 6 = startable transitional.
		// Docker nodes (XRD/cEOS/SR Linux) auto-create a persist .lock during
		// their first start (device_docker touch .lock, so device.php stop() keeps
		// the container instead of docker-rm'ing it). That lock makes a STOPPED
		// docker node report status 1, which the old `== 0 || == 6` test dropped
		// into the else → returned 0 (fake success) and NEVER called ->start(), so
		// the node silently failed to restart until a wipe removed the .lock. A
		// stopped node must be startable regardless of the lock (the lock protects
		// its disk/state, not the run action); only a RUNNING node (2/3) is skipped.
		if ($n->getStatus() == 0 || $n->getStatus() == 1 || $n->getStatus() == 6 ) {
			return $n->start();
		}
		else {
			return 0;
		}
}

/**
 * Function to stop a node.
 *
 * @param   Node    $n                  Node
 * @return  int                         0 means ok
 */
function stop($n)
{
	$n->stop();
	

}


function wipe($n)
{
	$n->wipe();

}

/**
 * Function to print how to use the unl_wrapper
 *
 * @return  string                      usage output
 */
function usage()
{
	global $argv;
	$output = '';
	$output .= "Usage: " . $argv[0] . " -a <action> <options>\n";
	$output .= "-a <s>     Action can be:\n";
	$output .= "           - delete: delete a lab file even if it's not valid\n";
	$output .= "                     requires -T, -F\n";
	$output .= "           - export: export a runnign-config to a file\n";
	$output .= "                     requires -T, -F, -D is optional\n";
	$output .= "           - fixpermissions: fix file/dir permissions\n";
	$output .= "           - platform: print the hardware platform\n";
	$output .= "           - start: start one or all nodes\n";
	$output .= "                     requires -T, -F, -D is optional\n";
	$output .= "           - stop: stop one or all nodes\n";
	$output .= "                     requires -T, -F, -D is optional\n";
	$output .= "           - wipe: wipe one or all nodes\n";
	$output .= "                     requires -T, -F, -D is optional\n";
	$output .= "Options:\n";
	$output .= "-F <n>     Lab file\n";
	$output .= "-T <n>     Tenant ID\n";
	$output .= "-D <n>     Device ID (if not used, all devices will be impacted)\n";
	$output .= "-S <n>     Lab Session\n";
	print($output);
}
