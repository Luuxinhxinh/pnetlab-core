<?php
# vim: syntax=php tabstop=4 softtabstop=0 noexpandtab laststatus=1 ruler

/**
 * html/includes/api_networks.php
 *
 * Networks related functions for REST APIs.
 *
 * @author Andrea Dainese <andrea.dainese@gmail.com>
 * @copyright 2014-2016 Andrea Dainese
 * @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
 * @link http://www.unetlab.com/
 * @version 20160719
 */

/**
 * Function to add a network to a lab.
 *
 * @param   Lab     $lab                Lab
 * @param   Array   $p                  Parameters
 * @param   bool    $o                  True if need to add ID to name
 * @return  Array                       Return code (JSend data)
 */
function apiAddLabNetwork($lab, $p, $o) {
	// Adding network_id to network_name if required

	$p['id'] = $lab -> getFreeNetworkId();
	if ($o == True && isset($p['name'])) $p['name'] = $p['name'].$p['id'];

	// Adding the network
	$rc = $lab -> addNetwork($p);

	if ($rc === 0) {
		// Network added
		$output['code'] = 201;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60006];
		$output['data'] = array(
			'id'=>$p['id']
		);
	} else {
		// Failed to add network
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}

/**
 * Function to delete a lab network.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $id                 Network ID
 * @return  Array                       Return code (JSend data)
 */
function apiDeleteLabNetwork($lab, $id) {
	// Deleting the network
	$rc = $lab -> deleteNetwork($id);

	//EVE_STORE hot link
	if ($rc === 0 || $rc == 1) {
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $rc == 0 ? $GLOBALS['messages'][60023] : 'success';
		
	} else {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = isset($GLOBALS['messages'][$rc])? $GLOBALS['messages'][$rc] : $rc;
	}
	return $output;
}

/**
 * Function to edit a lab network.
 *
 * @param   Lab     $lab                Lab
 * @param   Array   $p                  Parameters
 * @return  Array                       Return code (JSend data)
 */
function apiEditLabNetwork($lab, $p) {
	// Edit network
	$rc = $lab -> editNetwork($p);

	if ($rc === 0) {

		$output = apiGetLabNetworks($lab);
		if ($output['status'] == 'success') {
			$networks = $output['data'];
		}

		$output['code'] = 201;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60023];
		$output['data'] = [
			'networks' => $networks
		];
	} else {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}
function apiEditLabNetworkmanage($lab, $p) {
	// Edit network
	$rc = $lab -> editNetwork($p);

	if ($rc === 0) {

		$output = apiGetLabNetworks($lab);
		if ($output['status'] == 'success') {
			$networks = $output['data'];
		}

		$output['code'] = 201;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60023];
		$output['data'] = [
			'networks' => $networks
		];
	} else {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}
	return $output;
}

/**
 * Function to edit multiple lab networks.
 *
 * @param   Lab     $lab                Lab
 * @param   Array   $p                  Parameters
 * @return  Array                       Return code (JSend data)
 */
function apiEditLabNetworks($lab, $p) {
        // Edit network
        foreach ( $p as $network ) {
          $network['save'] = 0 ;
          $rc = $lab -> editNetwork($network);
        }
        $rc = $lab -> save() ;

        if ($rc === 0) {
			$output = apiGetLabNetworks($lab);
			if ($output['status'] == 'success') {
				$networks = $output['data'];
			}
	
			$output['code'] = 201;
			$output['status'] = 'success';
			$output['message'] = $GLOBALS['messages'][60023];
			$output['data'] = [
				'networks' => $networks
			];
        } else {
                $output['code'] = 400;
                $output['status'] = 'fail';
                $output['message'] = $GLOBALS['messages'][$rc];
        }
        return $output;
}

/**
 * Function to get a single lab network.
 *
 * @param   Lab     $lab                Lab
 * @param   int     $id                 Network ID
 * @return  Array                       Lab network (JSend data)
 */
function apiGetLabNetwork($lab, $id) {
	// Getting network
	if (isset($lab -> getNetworks()[$id])) {
		$network = $lab -> getNetworks()[$id];
		//$node = $lab->getNodes()[$id];
		$ethernets = array();
		// Printing networks
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60005];
		$output['data'] = Array(
			'count' => $network -> getCount(),
			'left' => $network -> getLeft(),
			'name' => $network -> getName(),
			'top' => $network -> getTop(),
			'type' => $network -> getNType(),
			'visibility' => $network -> getVisibility(),
			'icon' => $network->getIcon(),
			'size' => $network->getSize(),
			'smart' => $network->getsmart(),
			'vlan8021ad' => $network->getvlan8021ad(),

		);
		// soft-router: round-trip the saved gateway config so the Configure
		// dialog reopens populated. Config lives broker-side (per-run state),
		// so this is empty until the router has been configured this session.
		if ($network->getNType() == "router") {
			$resp = broker_call('router_get', array(
				'session' => (int) $lab->getSession(),
				'net_id'  => (int) $id));
			$cfg = ($resp['ok'] && !empty($resp['out'][0]))
				? json_decode($resp['out'][0], true) : array();
			$output['data']['RouterCfg'] = $cfg ? $cfg : new stdClass();
		}
		// wireless cell: round-trip the saved WLAN list (SSID+VLAN+security per
		// SSID) so the Configure dialog reopens populated. Config lives broker-
		// side (per-run), so this is empty until the cell has been configured.
		if ($network->getNType() == "wireless") {
			$resp = broker_call('wifi_cell_get', array(
				'session' => (int) $lab->getSession(),
				'net_id'  => (int) $id));
			$cfg = ($resp['ok'] && !empty($resp['out'][0]))
				? json_decode($resp['out'][0], true) : array();
			$output['data']['WifiCellCfg'] = $cfg ? $cfg : new stdClass();
		}
		foreach ($lab->getNodes() as $node_id => $node) {
			foreach ($node->getInterfaces() as $interface_id => $interface) {
				if ($interface->getNetworkId() > 0 && $lab -> getNetworks()[$interface->getNetworkId()] == $network) {
					$ethernets[] = array(
						'NodeName' => $node->getName(),
						'NodeId' => $node_id,
						'VlanId' => $interface->getVlanId(),
						'VlanMode' => method_exists($interface, 'getVlanMode') ? $interface->getVlanMode() : 'access',
						'Vlans' => method_exists($interface, 'getVlans') ? $interface->getVlans() : '',
						'IfId' =>  $interface_id,
						'IfName' => $interface->getName(),
					);

				}
			}
		}

                    
            
		$output['data']['interfaces'] =  $ethernets;

	} else {
		// Network not found
		$output['code'] = 404;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][20023];
	}
	return $output;
}

/**
 * Function to get all lab networks.
 *
 * @param   Lab     $lab                Lab
 * @return  Array                       Lab networks (JSend data)
 */
function apiGetLabNetworks($lab) {
	// Getting network(s)
	$networks = $lab -> getNetworks();

	// Printing networks
	$output['code'] = 200;
	$output['status'] = 'success';
	$output['message'] = $GLOBALS['messages'][60004];
	$output['data'] = Array();
	foreach ($networks as $network_id => $network) {
		$output['data'][$network_id] = Array(
			'count' => $network -> getCount(),
			'id' => $network_id,
			'left' => $network -> getLeft(),
			'name' => $network -> getName(),
			'top' => $network -> getTop(),
			'type' => $network -> getNType(),
			'visibility' => $network -> getVisibility(),
			'icon' => $network->getIcon(),
			'size' => $network->getSize(),
			'smart' => $network->getsmart(),
			'vlan8021ad' => $network->getvlan8021ad(),

		);
	}
	return $output;
}
