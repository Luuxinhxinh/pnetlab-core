<?php
# vim: syntax=php tabstop=4 softtabstop=0 noexpandtab laststatus=1 ruler

/**
 * html/includes/api_sdwan.php
 *
 * "Cisco SDWAN Lab Builder" backend — builds a standard Catalyst SD-WAN topology
 * (vManage + vBond + vSmart + N cEdge + underlay networks) into the open lab and
 * wires it, reusing the same Lab internals the REST node/network routes use.
 *
 * Node types (all day-0 prestaged — see device_cat*.php cidata handlers + the shipped
 * c8000vcm config_script bootstrap):
 *   vmanage -> catmanager   vbond -> catvalid   vsmart -> catcontrol   cedge -> c8000vcm
 *
 * Version-agnostic: images are addons/qemu/<template>-<version>/; the builder picks the
 * requested version or the latest available, never a hard-coded one.
 *
 * Phase 2a builds + wires (+ optional autostart). Control-plane onboarding (certs/serial/
 * templates) is the Phase 2b broker job; this handler only stands up the topology.
 *
 * @author pnetlab-noble sdwan-builder
 * @license BSD-3-Clause
 */

// role -> template filename (device handler / config_script bound by template name)
function sdwanRoleTemplates()
{
	return [
		'vmanage' => 'catmanager',
		'vbond'   => 'catvalid',
		'vsmart'  => 'catcontrol',
		'cedge'   => 'c8000vcm',
	];
}

/**
 * List installed image versions per role (scans addons/qemu/<template>-*).
 * @return Array  JSend: data => { role => { template, versions:[...] } }
 */
function apiSdwanListImages()
{
	$out = [];
	foreach (sdwanRoleTemplates() as $role => $tpl) {
		$versions = [];
		foreach (listNodeImages('qemu', $tpl) as $dir) {
			// dir = "<template>-<version>"; strip the "<template>-" prefix
			if (strpos($dir, $tpl . '-') === 0) {
				$versions[] = substr($dir, strlen($tpl) + 1);
			}
		}
		rsort($versions, SORT_NATURAL);          // newest first
		$out[$role] = ['template' => $tpl, 'versions' => $versions];
	}
	return [
		'code'    => 200,
		'status'  => 'success',
		'message' => '',
		'data'    => $out,
	];
}

/**
 * Read a template's defaults (ram/cpu/ethernet/console/qemu_*) from its yml.
 */
function sdwanTemplateDefaults($tpl)
{
	$path = BASE_DIR . '/html/' . TPL_DIR . '/' . $tpl . '.yml';
	$p = is_file($path) ? yaml_parse_file($path) : [];
	return [
		'ram'          => isset($p['ram']) ? (int) $p['ram'] : 1024,
		'cpu'          => isset($p['cpu']) ? (int) $p['cpu'] : 1,
		'ethernet'     => isset($p['ethernet']) ? (int) $p['ethernet'] : 4,
		'console'      => isset($p['console']) ? $p['console'] : 'telnet',
		'qemu_version' => isset($p['qemu_version']) ? $p['qemu_version'] : '',
		'qemu_nic'     => isset($p['qemu_nic']) ? $p['qemu_nic'] : '',
		'qemu_arch'    => isset($p['qemu_arch']) ? $p['qemu_arch'] : 'x86_64',
		'icon'         => isset($p['icon']) ? $p['icon'] : '',
	];
}

/**
 * Resolve a role to a concrete image dir name, honouring a requested version or
 * falling back to the newest installed. Returns "" if none installed.
 */
function sdwanResolveImage($tpl, $wantVersion)
{
	$dirs = array_values(listNodeImages('qemu', $tpl));
	if (empty($dirs)) return '';
	if ($wantVersion !== '' && in_array($tpl . '-' . $wantVersion, $dirs, true)) {
		return $tpl . '-' . $wantVersion;
	}
	natsort($dirs);
	return end($dirs);                            // newest
}

/**
 * Add one prestaged SD-WAN node, returning [id, error]. Sets image/ram/cpu/qemu_*
 * EXPLICITLY — an API/programmatic add does NOT inherit template defaults.
 */
function sdwanAddNode($lab, $role, $name, $version, $left, $top, $config = '0')
{
	$tpl = sdwanRoleTemplates()[$role];
	$image = sdwanResolveImage($tpl, $version);
	if ($image === '') {
		return [null, "No image installed for $role ($tpl)"];
	}
	$d = sdwanTemplateDefaults($tpl);

	$p = [
		'type'         => 'qemu',
		'template'     => $tpl,
		'name'         => $name,
		'image'        => $image,
		'ram'          => $d['ram'],
		'cpu'          => $d['cpu'],
		'ethernet'     => $d['ethernet'],
		'console'      => $d['console'],
		'qemu_version' => $d['qemu_version'],
		'qemu_nic'     => $d['qemu_nic'],
		'qemu_arch'    => $d['qemu_arch'],
		'icon'         => $d['icon'],
		'left'         => $left,
		'top'          => $top,
		// config='1' => the engine exports the stored config_data to the running
		// startup-config at boot (device.php), which the cidata handler then
		// delivers. Without it the federation day-0 is stored but never applied
		// and the node boots the base template — caught by the .203 live test.
		'config'       => $config,
	];

	$id = $lab->getFreeNodeId();
	$rc = $lab->addNode($p);
	if ($rc !== 0) {
		return [null, "addNode failed for $name (rc=$rc)"];
	}
	return [$id, null];
}

/**
 * Create a lab network of the given type, return its id (or null on failure).
 */
function sdwanAddNetwork($lab, $name, $type, $left, $top)
{
	$id = $lab->getFreeNetworkId();
	$rc = $lab->addNetwork([
		'name'       => $name,
		'type'       => $type,
		'left'       => $left,
		'top'        => $top,
		'visibility' => 1,
	]);
	return ($rc === 0) ? $id : null;
}

/* ============================ Phase 2b — federation ===========================
 *
 * When onboarding is requested, the controllers must boot with a day-0 that the
 * server-side onboarder (scripts/sdwan/sdwan-onboard.py) can federate: the SAME
 * org-name + bundled enterprise Root CA, and the static VPN0 transport IPs the
 * onboarder targets. We render those #cloud-config configs here (ported from the
 * Cisco CML deploy/*-cloud-init.j2, BSD-3) and store them as each node's
 * startup-config — the device_cat*.php handlers deliver a startup-config verbatim
 * as the cidata user-data.
 *
 * Transport plan (flat /24 INET underlay, no DNS — vBond reached by IP):
 *   vManage      system 100.0.0.1     VPN0 eth1   172.16.0.1/24   VPN512 eth0 = external
 *   vSmart  N    system 100.0.0.10N   VPN0 eth1   172.16.0.10N/24
 *   vBond   N    system 100.0.0.20N   VPN0 ge0/0  172.16.0.20N/24 (vbond local)
 * Interface order matches PNetLab wiring e0->Mgmt(eth0/VPN512), e1->INET(VPN0).
 * cEdges keep their c8000vcm bootstrap (zero-touch edge onboarding is deferred).
 * --------------------------------------------------------------------------- */

define('SDWAN_SCRIPTS_DIR', BASE_DIR . '/scripts/sdwan');

// vBond/vSmart boot with admin/admin (Cisco's bundled day-0 hash = crypt("admin")).
// The onboarder adds them with admin/admin; only vManage gets the custom password.
// (Overriding the controllers with a custom hash broke vManage's device-add auth —
// caught by the .203 live test.)
define('SDWAN_CTRL_PWHASH',
	'$6$9ac6af765f1cd0c0$jRM/rCPsQ56JlDU/1s9H7zhhksy/FZHv37zDJkzM6h/IU/FsnTcBuLwV3AVI5kCnfX9wYmqP8CsGk.4PrjC22/');

/** Read the bundled enterprise Root CA chain (chainCA.pem). */
function sdwanRootCa()
{
	$f = SDWAN_SCRIPTS_DIR . '/data/certs/chainCA.pem';
	$ca = is_file($f) ? file_get_contents($f) : '';
	return rtrim($ca, "\r\n");
}

/** SHA-512 crypt the admin password (viptela zcloud.xml accepts a $6$ hash). */
function sdwanCryptPassword($pw)
{
	$salt = '$6$' . substr(str_replace('+', '.', base64_encode(random_bytes(12))), 0, 16);
	return crypt($pw, $salt);
}

/** Indent every line of $text by $n spaces (for a YAML "content: |" block). */
function sdwanIndent($text, $n)
{
	$pad = str_repeat(' ', $n);
	$out = [];
	foreach (preg_split('/\r?\n/', rtrim($text, "\r\n")) as $line) {
		$out[] = ($line === '') ? '' : $pad . $line;
	}
	return implode("\n", $out);
}

/** Common viptela VPN0 transport tunnel-interface block (4-space indented under <interface>). */
function sdwanTunnelXml()
{
	return
		"            <tunnel-interface>\n" .
		"              <encapsulation>\n" .
		"                <encap>ipsec</encap>\n" .
		"              </encapsulation>\n" .
		"              <color>\n" .
		"                <value>default</value>\n" .
		"              </color>\n" .
		"              <allow-service>\n" .
		"                <sshd>true</sshd>\n" .
		"                <netconf>true</netconf>\n" .
		"              </allow-service>\n" .
		"            </tunnel-interface>\n";
}

/** Wrap a viptela zcloud.xml + root-ca into a #cloud-config write_files payload. */
function sdwanCloudConfig($personality, $rootca, $zcloudXml, $withDataDisk)
{
	$out = "#cloud-config\n";
	if ($withDataDisk) {
		$out .=
			"fs_setup:\n- device: \"/dev/vdb\"\n  partition: \"none\"\n  filesystem: \"ext4\"\n" .
			"mounts:\n- [ vdb, /opt/data ]\n";
	}
	$out .= "write_files:\n";
	$out .= "- path: /etc/default/personality\n  content: \"" . $personality . "\\n\"\n";
	$out .= "- path: /etc/default/inited\n  content: \"1\\n\"\n";
	$out .= "- path: /usr/share/viptela/root-ca.crt\n  content: |\n" . sdwanIndent($rootca, 4) . "\n";
	$out .= "- path: /etc/confd/init/zcloud.xml\n  content: |\n" . sdwanIndent($zcloudXml, 4) . "\n";
	return $out;
}

/** vManage federation day-0. */
function sdwanRenderManager($name, $org, $rootca, $pwhash, $extIp, $extMask, $extGw, $validatorIp)
{
	$xml =
		"<config xmlns=\"http://tail-f.com/ns/config/1.0\">\n" .
		"  <system xmlns=\"http://viptela.com/system\">\n" .
		"    <personality>vmanage</personality>\n    <device-model>vmanage</device-model>\n" .
		"    <organization-name>$org</organization-name>\n    <sp-organization-name>$org</sp-organization-name>\n" .
		"    <vbond>\n      <remote>$validatorIp</remote>\n      <port>12346</port>\n    </vbond>\n" .
		"    <site-id>100</site-id>\n    <system-ip>100.0.0.1</system-ip>\n    <host-name>$name</host-name>\n    <domain-id>1</domain-id>\n" .
		"    <aaa>\n      <user>\n        <name>admin</name>\n        <password>$pwhash</password>\n        <group>netadmin</group>\n      </user>\n    </aaa>\n" .
		"  </system>\n" .
		"  <vpn xmlns=\"http://viptela.com/vpn\">\n" .
		"    <vpn-instance>\n      <vpn-id>0</vpn-id>\n" .
		"      <interface>\n        <if-name>eth1</if-name>\n        <ip>\n          <address>172.16.0.1/24</address>\n        </ip>\n" .
		sdwanTunnelXml() .
		"        <shutdown>false</shutdown>\n      </interface>\n    </vpn-instance>\n" .
		"    <vpn-instance>\n      <vpn-id>512</vpn-id>\n" .
		"      <ip>\n        <route>\n          <prefix>0.0.0.0/0</prefix>\n          <next-hop>\n            <address>$extGw</address>\n          </next-hop>\n        </route>\n      </ip>\n" .
		"      <interface>\n        <if-name>eth0</if-name>\n        <ip>\n          <address>$extIp$extMask</address>\n        </ip>\n        <shutdown>false</shutdown>\n      </interface>\n    </vpn-instance>\n" .
		"  </vpn>\n</config>\n";
	return sdwanCloudConfig('vmanage', $rootca, $xml, true);
}

/** vSmart (Controller) federation day-0; $n = controller index (1..). */
function sdwanRenderController($name, $org, $rootca, $pwhash, $validatorIp, $n)
{
	$last = 100 + $n;       // system 100.0.0.10N, transport 172.16.0.10N
	$xml =
		"<config xmlns=\"http://tail-f.com/ns/config/1.0\">\n" .
		"  <system xmlns=\"http://viptela.com/system\">\n" .
		"    <personality>vsmart</personality>\n    <device-model>vsmart</device-model>\n" .
		"    <organization-name>$org</organization-name>\n    <sp-organization-name>$org</sp-organization-name>\n" .
		"    <vbond>\n      <remote>$validatorIp</remote>\n      <port>12346</port>\n    </vbond>\n" .
		"    <site-id>100</site-id>\n    <system-ip>100.0.0.$last</system-ip>\n    <host-name>$name</host-name>\n    <domain-id>1</domain-id>\n" .
		"    <aaa>\n      <user>\n        <name>admin</name>\n        <password>$pwhash</password>\n        <group>netadmin</group>\n      </user>\n    </aaa>\n" .
		"  </system>\n" .
		"  <vpn xmlns=\"http://viptela.com/vpn\">\n" .
		"    <vpn-instance>\n      <vpn-id>0</vpn-id>\n" .
		"      <interface>\n        <if-name>eth1</if-name>\n        <ip>\n          <address>172.16.0.$last/24</address>\n        </ip>\n" .
		sdwanTunnelXml() .
		"        <shutdown>false</shutdown>\n      </interface>\n    </vpn-instance>\n" .
		"  </vpn>\n</config>\n";
	return sdwanCloudConfig('vsmart', $rootca, $xml, false);
}

/** vBond (Validator) federation day-0; $n = validator index (1..). vBond = local. */
function sdwanRenderValidator($name, $org, $rootca, $pwhash, $n)
{
	$last = 200 + $n;       // system 100.0.0.20N, transport 172.16.0.20N (ge0/0)
	$xml =
		"<config xmlns=\"http://tail-f.com/ns/config/1.0\">\n" .
		"  <system xmlns=\"http://viptela.com/system\">\n" .
		"    <personality>vedge</personality>\n    <device-model>vedge-cloud</device-model>\n" .
		"    <organization-name>$org</organization-name>\n    <sp-organization-name>$org</sp-organization-name>\n" .
		"    <vbond>\n      <local></local>\n      <remote>172.16.0.$last</remote>\n      <port>12346</port>\n    </vbond>\n" .
		"    <site-id>100</site-id>\n    <system-ip>100.0.0.$last</system-ip>\n    <host-name>$name</host-name>\n    <domain-id>1</domain-id>\n" .
		"    <aaa>\n      <user>\n        <name>admin</name>\n        <password>$pwhash</password>\n        <group>netadmin</group>\n      </user>\n    </aaa>\n" .
		"  </system>\n" .
		"  <vpn xmlns=\"http://viptela.com/vpn\">\n" .
		"    <vpn-instance>\n      <vpn-id>0</vpn-id>\n" .
		"      <interface>\n        <if-name>ge0/0</if-name>\n        <ip>\n          <address>172.16.0.$last/24</address>\n        </ip>\n" .
		sdwanTunnelXml() .
		"        <shutdown>false</shutdown>\n      </interface>\n    </vpn-instance>\n" .
		"  </vpn>\n</config>\n";
	return sdwanCloudConfig('vedge', $rootca, $xml, false);
}

/* ---- cEdge (c8000v) zero-touch onboarding (2c-i) ---------------------------
 *
 * A c8000v joins the fabric by booting a MIME multipart day-0 that injects an
 * allow-listed chassis UUID (vinitparam uuid/vbond/otp/org/rcc) + the Root CA.
 * The UUID must exist in the uploaded serial file; the bundled serial's chassis
 * list is fixed, so we read it from a sidecar (chassis-v{1,2}.json) at build time
 * and assign one per cEdge — the onboarder uploads the SAME serial, so vManage
 * authorizes them. After they come up, the onboarder associates+deploys the
 * edge_basic config-group (see sdwan-onboard.py stage_edges).
 *
 * Edges are wired Gi1->INET, Gi2->MPLS, Gi3->mgmt to match edge_basic. In this
 * first slice (no underlay router) the INET transport is kept on the control /24
 * so the edge reaches vBond directly; the cloud-boothook brings Gi1 up statically.
 * NOTE: the boothook/ZTP path for c8000v is the one piece that wants a hardware
 * run to confirm; the DHCP/soft-router underlay (2c-iii) is the fallback.
 * --------------------------------------------------------------------------- */

// Shared one-time-password the bundled serial expects (rcc = request controller cert).
define('SDWAN_EDGE_OTP', '59aac1776710406abb086f8fd7311977');

/** Config/serial generation from a viptela version (1 = 20.4–20.11, 2 = 20.12+). */
function sdwanConfigVersion($version)
{
	$parts = explode('.', (string) $version);
	$maj = isset($parts[0]) ? (int) $parts[0] : 0;
	$min = isset($parts[1]) ? (int) $parts[1] : 0;
	if ($maj == 20 && $min >= 4 && $min <= 11) return 1;
	return 2;                                  // 20.12+ (and unknown) → config-groups
}

/** Ordered C8K chassis IDs from the bundled serial sidecar (chassis-v{1,2}.json). */
function sdwanChassisList($configVersion)
{
	$f = SDWAN_SCRIPTS_DIR . '/data/serial_files/chassis-v' . (int) $configVersion . '.json';
	if (!is_file($f)) return [];
	$d = json_decode(file_get_contents($f), true);
	return (is_array($d) && isset($d['chassis']) && is_array($d['chassis'])) ? $d['chassis'] : [];
}

// cEdge console password the boothook sets for the admin user. Kept "admin" so it
// matches the edge_basic config-group's aaa_password and the onboarder's console
// login (sdwan-onboard.py activate_edges tries "admin" first). IOS-XE stores it as a
// type-9 secret on apply.
define('SDWAN_EDGE_ADMIN_PW', 'admin');

/**
 * Render a c8000v SD-WAN cEdge MIME day-0:
 *   cloud-config  (HONORED by this image) — vinitparam (uuid/vbond/otp/org) + the
 *                 enterprise Root CA via ca-certs.
 *   cloud-boothook (HONORED only when wrapped in config-transaction/commit — a raw
 *                 unwrapped block is silently dropped, which earlier looked like
 *                 "the boothook is ignored"). It creates the admin user (so the
 *                 onboarder can log in over the console), brings Gi1 up on the
 *                 static transport IP, and lays down the SD-WAN system + tunnel
 *                 config so the edge can form a control connection.
 *
 * The per-device cloud activation (request platform software sdwan vedge_cloud
 * activate ... token <vManage token>) still happens over the console from the
 * onboarder, because that token is generated by vManage at onboarding time and is
 * not known when this day-0 is built. The c8000vcm handler delivers a startup-config
 * containing "MIME-Version:" verbatim.
 */
function sdwanRenderEdge($name, $org, $rootca, $uuid, $validatorIp, $inetIp, $systemIp = '', $siteId = '')
{
	$caIndented = sdwanIndent($rootca, 3);     // 3-space indent under the trusted: "- |"
	$adminPw = SDWAN_EDGE_ADMIN_PW;
	// IOS-XE SD-WAN boothook MUST be wrapped in config-transaction ... commit or the
	// image drops it. Sets admin login + static transport + the SD-WAN system/tunnel
	// config (the proven manual recipe). No global indent — IOS parses leading spaces
	// as hierarchy, and config-transaction at column 0 is required.
	$boothook =
		"config-transaction\n" .
		// Silence console logging — the c8000v firehoses %SMART_LIC / %LINEPROTO
		// messages that otherwise interleave with (and corrupt) the long
		// vedge_cloud activate command the onboarder types over the console.
		" no logging console\n" .
		" username admin privilege 15 secret 0 $adminPw\n" .
		" system\n" .
		"  system-ip $systemIp\n" .
		"  site-id $siteId\n" .
		"  organization-name $org\n" .
		"  vbond $validatorIp port 12346\n" .
		" !\n" .
		" interface GigabitEthernet1\n" .
		"  no shutdown\n" .
		"  ip address $inetIp 255.255.255.0\n" .
		" !\n" .
		" interface Tunnel1\n" .
		"  no shutdown\n" .
		"  ip unnumbered GigabitEthernet1\n" .
		"  tunnel source GigabitEthernet1\n" .
		"  tunnel mode sdwan\n" .
		" !\n" .
		" sdwan\n" .
		"  interface GigabitEthernet1\n" .
		"   tunnel-interface\n" .
		"    encapsulation ipsec\n" .
		"    color default\n" .
		"   exit\n" .
		"  exit\n" .
		" !\n" .
		"commit\n";
	$bootIndented = $boothook;
	$cfgFilename = 'config-' . $uuid . '.txt';

	return
		"Content-Type: multipart/mixed; boundary=\"==BOUNDARY==\"\n" .
		"MIME-Version: 1.0\n\n" .
		"--==BOUNDARY==\n" .
		"Content-Type: text/cloud-config; charset=\"us-ascii\"\n" .
		"MIME-Version: 1.0\n" .
		"Content-Transfer-Encoding: 7bit\n" .
		"Content-Disposition: attachment; filename=\"cloud-config\"\n\n" .
		"#cloud-config\n" .
		"vinitparam:\n" .
		" - uuid : $uuid\n" .
		" - vbond : $validatorIp\n" .
		" - otp : " . SDWAN_EDGE_OTP . "\n" .
		" - org : $org\n" .
		" - rcc : true\n" .
		"ca-certs:\n" .
		"  remove-defaults: false\n" .
		"  trusted:\n" .
		"  - |\n" .
		$caIndented . "\n\n" .
		"--==BOUNDARY==\n" .
		"Content-Type: text/cloud-boothook; charset=\"us-ascii\"\n" .
		"MIME-Version: 1.0\n" .
		"Content-Transfer-Encoding: 7bit\n" .
		"Content-Disposition: attachment; filename=\"$cfgFilename\"\n\n" .
		"#cloud-boothook\n" .
		$bootIndented . "\n" .
		"--==BOUNDARY==\n";
}

/** Normalize a subnet mask field to "/NN" (accepts "24", "/24", or "255.255.255.0"). */
function sdwanNormalizeMask($m)
{
	$m = trim((string) $m);
	if ($m === '') return '/24';
	if ($m[0] === '/') return $m;
	if (ctype_digit($m)) return '/' . $m;
	// dotted mask -> prefix length
	$long = ip2long($m);
	if ($long !== false) {
		$bits = 0;
		for ($i = 31; $i >= 0; $i--) { if ($long & (1 << $i)) $bits++; else break; }
		return '/' . $bits;
	}
	return '/24';
}

/**
 * Build the standard SD-WAN topology into $lab.
 *
 * Params ($p):
 *   vbond, vsmart, cedge : counts (defaults 1,1,1)
 *   version              : optional viptela version (e.g. "20.16.1"); edge uses latest
 *   mgmt_type            : management network type (default "pnet0" = Cloud, host-reachable)
 *   autostart            : "1" to start nodes after building
 *   onboard              : "1" to render the federation day-0 + launch the onboarding job
 *   org_name             : SD-WAN org (default "cml-sdwan-lab-tool" — matches bundled certs/serial)
 *   admin_password       : new vManage admin password (required for onboarding; cannot be "admin")
 *   mgr_ip, mgr_mask, mgr_gw : vManage external (VPN512) address on the mgmt net
 *   serial_b64           : optional base64 PnP serial (.viptela) for cEdge allow-list
 */
function apiSdwanBuild($lab, $p, $tenant)
{
	$nVbond = max(1, min(8,  (int) get($p['vbond'], 1)));
	$nVsmart = max(1, min(12, (int) get($p['vsmart'], 1)));
	$nCedge = max(0, min(20, (int) get($p['cedge'], 1)));
	$version = (string) get($p['version'], '');
	$mgmtType = (string) get($p['mgmt_type'], 'pnet0');
	$onboard = (string) get($p['onboard'], '0') === '1';
	$autostart = $onboard || (string) get($p['autostart'], '0') === '1';

	// Onboarding inputs (validated up-front so we don't build a half-usable lab).
	$org = trim((string) get($p['org_name'], 'cml-sdwan-lab-tool'));
	$adminPassword = (string) get($p['admin_password'], '');
	$mgrIp  = trim((string) get($p['mgr_ip'], ''));
	$mgrMask = sdwanNormalizeMask(get($p['mgr_mask'], '/24'));
	$mgrGw  = trim((string) get($p['mgr_gw'], ''));
	if ($onboard) {
		if ($org === '') $org = 'cml-sdwan-lab-tool';
		if ($adminPassword === '' || strtolower($adminPassword) === 'admin') {
			return ['code' => 400, 'status' => 'fail',
				'message' => 'Onboarding requires an admin password (and it cannot be "admin").'];
		}
		if (filter_var($mgrIp, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false ||
			filter_var($mgrGw, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false) {
			return ['code' => 400, 'status' => 'fail',
				'message' => 'Onboarding requires a valid Manager external IP and gateway.'];
		}
	}

	// 1) Underlay/management networks.
	$net = [];
	$net['mgmt'] = sdwanAddNetwork($lab, 'SDWAN-Mgmt', $mgmtType, 60, 60);
	$net['inet'] = sdwanAddNetwork($lab, 'SDWAN-INET', 'bridge', 60, 220);
	$net['mpls'] = sdwanAddNetwork($lab, 'SDWAN-MPLS', 'bridge', 60, 380);
	// Isolated branch-LAN bridge for cEdge Gi3 (VPN1 service interface in edge_basic,
	// which runs a DHCP server) — kept OFF the management net so the edge's branch
	// LAN/DHCP never lands on the real Cloud (pnet0) management domain.
	if ($onboard && $nCedge > 0) {
		$net['lan'] = sdwanAddNetwork($lab, 'SDWAN-LAN', 'bridge', 60, 540);
	}
	foreach ($net as $k => $v) {
		if ($v === null) {
			return ['code' => 400, 'status' => 'fail', 'message' => "Failed to create $k network"];
		}
	}

	$created = ['nodes' => [], 'networks' => $net];
	$errors = [];
	$x = 220;

	$rootca = $onboard ? sdwanRootCa() : '';
	$pwhash = $onboard ? sdwanCryptPassword($adminPassword) : '';
	$validatorIp = '172.16.0.201';       // vBond#1 transport — the federation anchor
	$validatorIps = [];
	$controllerIps = [];

	// 2) Control plane. Controllers: eth0 -> Mgmt (VPN512), eth1 -> INET (VPN0 transport).
	$ctrlSpec = [['vmanage', 'vManage', 1]];
	for ($i = 1; $i <= $nVsmart; $i++) $ctrlSpec[] = ['vsmart', 'vSmart' . sprintf('%02d', $i), $i];
	for ($i = 1; $i <= $nVbond; $i++)  $ctrlSpec[] = ['vbond', 'vBond' . sprintf('%02d', $i), $i];

	$y = 60;
	foreach ($ctrlSpec as $spec) {
		list($role, $name, $idx) = $spec;
		list($id, $err) = sdwanAddNode($lab, $role, $name, $version, $x, $y, $onboard ? '1' : '0');
		if ($err) { $errors[] = $err; continue; }
		$lab->connectNode($id, [0 => $net['mgmt'], 1 => $net['inet']]);
		if ($onboard) {
			if ($role === 'vmanage') {
				$cfg = sdwanRenderManager($name, $org, $rootca, $pwhash, $mgrIp, $mgrMask, $mgrGw, $validatorIp);
			} elseif ($role === 'vsmart') {
				// controllers stay admin/admin (Cisco fixed hash) — onboarder adds them with admin/admin
				$cfg = sdwanRenderController($name, $org, $rootca, SDWAN_CTRL_PWHASH, $validatorIp, $idx);
				$controllerIps[] = '172.16.0.' . (100 + $idx);
			} else { // vbond
				$cfg = sdwanRenderValidator($name, $org, $rootca, SDWAN_CTRL_PWHASH, $idx);
				$validatorIps[] = '172.16.0.' . (200 + $idx);
			}
			$lab->setNodeConfigData($id, $cfg);
		}
		$created['nodes'][] = ['id' => $id, 'role' => $role, 'name' => $name];
		$y += 120;
	}

	// 3) Edges (cEdge / c8000vcm).
	//    Plain build: Gi1->mgmt, Gi2->INET, Gi3->MPLS (2a behaviour).
	//    Onboard:     Gi1->INET, Gi2->MPLS, Gi3->SDWAN-LAN  — matches the edge_basic
	//                 config-group (vpn0 gi1=INET, gi2=MPLS, vpn1 gi3=LAN). The INET
	//                 transport stays on the control /24 so the edge reaches vBond;
	//                 Gi3 (VPN1 LAN + DHCP) lands on an isolated bridge, not mgmt.
	$edges = [];
	$chassis = $onboard ? sdwanChassisList(sdwanConfigVersion($version)) : [];
	$x = 460; $y = 60;
	for ($i = 1; $i <= $nCedge; $i++) {
		$name = 'cEdge' . sprintf('%02d', $i);
		list($id, $err) = sdwanAddNode($lab, 'cedge', $name, $version, $x, $y, $onboard ? '1' : '0');
		if ($err) { $errors[] = $err; continue; }
		if ($onboard) {
			if (!isset($chassis[$i - 1])) {
				$errors[] = "No free chassis UUID for $name (serial has " . count($chassis) . ')';
				$lab->connectNode($id, [0 => $net['inet'], 1 => $net['mpls'], 2 => $net['lan']]);
				$created['nodes'][] = ['id' => $id, 'role' => 'cedge', 'name' => $name];
				$y += 120;
				continue;
			}
			$uuid = $chassis[$i - 1];
			$inetIp = '172.16.0.' . (50 + $i);     // on the control /24, reaches vBond
			$lab->connectNode($id, [0 => $net['inet'], 1 => $net['mpls'], 2 => $net['lan']]);
			$lab->setNodeConfigData($id, sdwanRenderEdge(
				$name, $org, $rootca, $uuid, $validatorIp, $inetIp, '10.0.0.' . $i, $i));
			// Console port/host so the onboarder can drive this cEdge's serial console
			// to run the per-device cloud activation (vedge_cloud activate ... token),
			// whose vManage token is only known at onboarding time — see
			// sdwan-onboard.py activate_edges. The boothook above already lays down the
			// login + transport/system config; only the activate needs the console.
			// The port is assigned
			// when the node session is created (Node ctor, lab is open), so it is
			// already populated here, before autostart. Single-host master => the
			// qemu_wrapper_telnet listens on 127.0.0.1:<port>; cluster-satellite
			// placement (session_host != 0) is not yet supported for console drive.
			$cnode = isset($lab->getNodes()[$id]) ? $lab->getNodes()[$id] : null;
			$cport = $cnode ? (int) $cnode->getPort() : 0;
			$chost = '127.0.0.1';
			if ($cnode && method_exists($cnode, 'getSessionHost') && (int) $cnode->getSessionHost() !== 0) {
				$chost = '';   // satellite-hosted: onboarder will skip (no reachable console)
			}
			$edges[] = [
				'uuid'         => $uuid,
				'host_name'    => $name,
				'system_ip'    => '10.0.0.' . $i,
				'site_id'      => $i,
				'inet_ip'      => $inetIp,
				'mpls_ip'      => '172.16.2.' . $i,
				'lan_ip'       => '192.168.' . $i . '.1',
				'lan_net'      => '192.168.' . $i . '.0',
				'console_port' => $cport,
				'console_host' => $chost,
			];
		} else {
			// c8000vcm: Gi1=if0 (mgmt VPN512), Gi2=if1 (INET), Gi3=if2 (MPLS)
			$lab->connectNode($id, [0 => $net['mgmt'], 1 => $net['inet'], 2 => $net['mpls']]);
		}
		$created['nodes'][] = ['id' => $id, 'role' => 'cedge', 'name' => $name];
		$y += 120;
	}

	// 4) Autostart (forced when onboarding — the onboarder needs the nodes booting).
	$started = 0;
	if ($autostart) {
		foreach ($created['nodes'] as $n) {
			$r = apiStartLabNode($lab, $n['id'], $tenant);
			if (isset($r['code']) && $r['code'] == 200) $started++;
		}
	}

	// 5) Kick the server-side onboarding job (broker -> html/sdwan/worker.sh).
	$job = null;
	if ($onboard) {
		if (empty($validatorIps)) $validatorIps = [$validatorIp];
		if (empty($controllerIps)) $controllerIps = ['172.16.0.101'];
		$job = sdwanLaunchOnboard([
			'manager_ip'       => $mgrIp,
			'manager_port'     => 443,
			'manager_user'     => 'admin',
			'manager_password' => $adminPassword,
			'org_name'         => $org,
			'validator_ips'    => $validatorIps,
			'controller_ips'   => $controllerIps,
			'edges'            => $edges,
			'software_version' => $version,
			'do_templates'     => true,
			'ip_type'          => 'v4',
		], get($p['serial_b64'], ''), $errors);
		if ($job) $created['job'] = $job;
	}

	$msg = sprintf('SD-WAN topology built: %d node(s), %d network(s)%s%s.',
		count($created['nodes']), count($net),
		$autostart ? ", $started started" : '',
		$job ? ', onboarding started' : '');

	return [
		'code'    => 201,
		'status'  => empty($errors) ? 'success' : 'partial',
		'message' => $msg . (empty($errors) ? '' : ' Errors: ' . implode('; ', $errors)),
		'data'    => $created,
		'errors'  => $errors,
	];
}

/**
 * Write the 0600 job request (+ optional serial) and launch worker_sdwan via the
 * broker. Returns the 16-hex job id, or null (with $errors appended) on failure.
 * The admin password lives only in the 0600 .req, which worker.sh shreds at once.
 */
function sdwanLaunchOnboard($req, $serialB64, &$errors)
{
	$jobsDir = BASE_DIR . '/html/sdwan/jobs';
	if (!is_dir($jobsDir)) @mkdir($jobsDir, 0777, true);
	$job = bin2hex(random_bytes(8));

	file_put_contents("$jobsDir/$job.json",
		json_encode(['state' => 'queued', 'pct' => 0, 'msg' => 'queued']));
	@chmod("$jobsDir/$job.json", 0666);

	// optional PnP serial (.viptela) for cEdge allow-list — small file, base64 in JSON
	if (is_string($serialB64) && $serialB64 !== '') {
		$raw = base64_decode($serialB64, true);
		if ($raw !== false && strlen($raw) > 0 && strlen($raw) < 1048576) {
			$sp = "$jobsDir/$job.serial";
			file_put_contents($sp, $raw);
			@chmod($sp, 0600);
			$req['serial_file'] = $sp;
		}
	}

	file_put_contents("$jobsDir/$job.req", json_encode($req));
	@chmod("$jobsDir/$job.req", 0600);

	$resp = broker_call('worker_sdwan', ['job' => $job]);
	if (empty($resp['ok'])) {
		@unlink("$jobsDir/$job.req");
		$errors[] = 'onboarding worker failed to start: ' . get($resp['err'], 'broker error');
		return null;
	}
	return $job;
}
