<?php
/**
 * pnq-overlay.php — Topology Overlay endpoint (Protocol Inspector sibling).
 *
 * Draws a protocol's computed forwarding picture onto the lab canvas. v1 = OSPF
 * SPF tree. Read-only by contract: every console read goes through the brokerd
 * `node_show` verb (validated against ^show ...$), so this can never push config.
 *
 *   GET  ?list=1
 *        -> running telnet-console nodes (candidate overlay roots):
 *           {"nodes":[{node_id,name,port,host}]}
 *
 *   POST {"action":"ospf","root_node_id":N}
 *        -> Gathers `show cdp neighbors detail` (LLDP fallback) on every running
 *           node + `show ip ospf interface brief` on each, correlates via
 *           pnet_topomap, runs Dijkstra (pnet_routeoverlay) from node N, and
 *           returns the SPF tree mapped onto canvas node-pairs:
 *           {"proto":"ospf","root":N,"names":{id:name},
 *            "edges":[{a,b,cost_ab,cost_ba,in_tree,ecmp,dir}],
 *            "dist":{id:cost}, "adjacencies":[..], "unreachable":[..],
 *            "warnings":[..]}
 *        When no OSPF is present the edges come back with in_tree=false and a
 *        warning, so the client still renders the discovered topology.
 *
 * Auth + lab model mirror pnq-bgppath.php. The SPF computation runs as a pure
 * (unprivileged) python helper — no root, just CPU.
 */
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');
@set_time_limit(180);                 // 2 console reads x N nodes, sequential
function out($x, $code = 200) { http_response_code($code); echo json_encode($x); exit; }

$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) out(['error' => 'not authenticated'], 401);

$session = isset($user['lab']) ? $user['lab'] : '';
if ($session === '') out(['error' => 'no lab session'], 400);

function ov_open_lab($session, $tenant) {
    $labsession = getLabFromSession($session);
    if (!$labsession) throw new Exception('no lab session');
    return new Lab(BASE_LAB . $labsession['lab_session_path'], $tenant, $session);
}

/* Running nodes that expose a telnet serial console (same rule as the BGP
   waterfall: getNodeStatus 2 running / 3 running+locked). */
function ov_console_nodes($lab) {
    $rows = [];
    foreach ($lab->getNodes() as $node_id => $node) {
        $status = intval($node->getStatus());
        if ($status !== 2 && $status !== 3) continue;
        // IOL/dynamips always use a telnet console, but getconsole() only returns
        // 'telnet' when the lab XML carries a `console` attribute (device.php
        // forces it for these types *inside* that isset guard) — so an IOL node
        // can report console='' yet be fully telnet-reachable. Accept by type.
        $ntype = $node->getNType();
        if ($node->getconsole() !== 'telnet'
            && !in_array($ntype, ['iol', 'dynamips'], true)) continue;
        $port = intval($node->getPort());
        if ($port <= 0) continue;
        $host = $node->getHost();
        if (!filter_var($host, FILTER_VALIDATE_IP)) $host = '127.0.0.1';
        $rows[intval($node_id)] = [
            'node_id' => intval($node_id), 'name' => $node->getName(),
            'port' => $port, 'host' => $host,
            // host that runs this node's session: 0 master, >0 satellite slot.
            // node_show / the gather route there (local console) for sat nodes.
            'host_id' => cluster_session_host($lab, $node_id),
            // NOS flavour drives the per-node show commands + parsers (NX-OS differs).
            'nos' => ov_node_nos($node),
            // template/image hint — used to keep the probe set to Cisco NOS nodes
            // relevant to the requested protocol (see ov_node_relevant).
            'tpl' => strtolower((string) $node->getTemplate() . ' ' . (string) $node->getImage()),
        ];
    }
    return $rows;
}

/* Per-read broker timeout for a single interactive overlay read. Bounded well
   below the old 75s: a live paint that waits longer than this on one console isn't
   useful, and the readiness pre-check (ov_console_ready) has already skipped
   consoles that aren't emitting a prompt, so a read that reaches here should finish
   in a few seconds. */
define('OV_READ_TIMEOUT', 12);

/* Does a chunk of console output show a REACHABLE prompt — i.e. one that
   pnet-showcmd's to_exec can drive to an exec/enable prompt quickly? Accept:
     - an exec / enable / config prompt : a line ending in `#` or `>` (R1#, SW1>,
       R1(config-if)#)
     - a login prompt                   : `Username:` / `Password:` / `login:`
   REJECT the deceptive not-ready cases that still emit bytes but then stall the
   full 40s login:
     - the first-boot "initial configuration dialog? [yes/no]:" prompt (ends `]:`),
       which an unconfigured IOS/IOL node parks at after reload — to_exec never
       answers it and burns its whole 40s window.
   This is the difference that matters: the OLD probe accepted ANY byte, so a node
   sitting at the config dialog passed readiness yet still stalled the concurrent
   gather ~40s. Requiring a real prompt classifies it not-ready and excludes it. */
function ov_console_has_prompt($got) {
    // Strip a trailing xterm title / control noise so the real prompt tail shows.
    $tail = substr($got, -160);
    if (preg_match('/[A-Za-z0-9][\w.\-]*(\([\w\-]+\))?[#>]\s*$/', $tail)) return true;
    if (preg_match('/(?:[Uu]sername|[Pp]assword|[Ll]ogin)\s*:\s*$/', $tail)) return true;
    return false;
}

/* FAST console-readiness pre-check. A not-yet-booted / mid-reload / unconfigured
   IOL/IOS telnet console ACCEPTS the TCP connect instantly and may even print a
   banner or the first-boot "initial configuration dialog?" prompt, but never
   reaches an exec prompt — so a full node_show blocks the whole 40s login window
   (pnet-showcmd to_exec) before giving up, the dominant overlay stall. This probe
   bounds that to ~1.5s: connect, nudge with a CR, and require a REAL exec/login
   PROMPT (not merely any byte — see ov_console_has_prompt) within ~1.2s. A ready
   console echoes `SW1#`; a booting one stays silent or parks at a config dialog, so
   we skip it and cost ~1.5s instead of ~40s.

   MASTER-LOCAL ONLY: satellite consoles live on the satellite's own 127.0.0.1 and
   are reached via the cluster relay — never open a socket to them from the master.
   Callers pass through host_id>0 nodes unprobed (the relay/broker still applies its
   own timeout there). Read-only: we only read bytes, we send a lone CR which the
   IOS/IOL exec ignores (it just reprints the prompt). */
function ov_console_ready($host, $port) {
    $errno = 0; $errstr = '';
    $fp = @fsockopen($host, (int) $port, $errno, $errstr, 1.5);
    if (!$fp) return false;                 // port not accepting = console down
    stream_set_timeout($fp, 1);
    @fwrite($fp, "\r\n");
    $deadline = microtime(true) + 1.5;
    $got = '';
    while (microtime(true) < $deadline) {
        $chunk = @fread($fp, 256);
        if ($chunk === '' || $chunk === false) {
            $info = stream_get_meta_data($fp);
            if (!empty($info['timed_out'])) { usleep(50000); continue; }
            usleep(50000);
            continue;
        }
        $got .= $chunk;
        if (ov_console_has_prompt($got)) { @fclose($fp); return true; }
    }
    @fclose($fp);
    return ov_console_has_prompt($got);
}

/* CONCURRENT readiness probe over a whole node set — the parallel sibling of
   ov_console_ready. The single-socket version above is fine for a lone read, but
   calling it in a loop over N nodes serialises N×~1.5s of dead wait in FRONT of the
   already-parallel gather (the "not reading in parallel anymore" regression). This
   opens every master-local console at once with non-blocking sockets, nudges each
   with a CR, and waits with ONE stream_select() loop up to ~1.5s TOTAL — so the
   whole readiness gate costs ~one wait, not the sum. Same protection as before: a
   booting/held console that accepts TCP but never emits a prompt is marked not-ready
   and skipped, so it can't stall the gather for its full ~40s login.

   Returns [id => bool ready]. A node is READY only when it shows a real exec/login
   PROMPT (ov_console_has_prompt) — NOT merely any byte: an unconfigured node parked
   at the first-boot "initial configuration dialog?" prompt emits plenty of bytes yet
   still stalls the 40s gather login, so byte-only readiness let it through. Requiring
   a prompt excludes it, so the concurrent gather that follows only reads consoles
   that will answer quickly. Satellite-placed nodes (host_id>0) aren't probed from the
   master (their console lives on the satellite's own 127.0.0.1, reached via the relay,
   which applies its own timeout) — they're reported ready unconditionally, exactly as
   the serial version treated them. Read-only: a lone CR the IOS/IOL exec reprints its
   prompt for. */
function ov_console_ready_map($rows) {
    $ready = [];
    $conns = [];     // id => stream
    $buf = [];       // id => bytes seen so far
    foreach ($rows as $id => $n) {
        $hid = isset($n['host_id']) ? (int) $n['host_id'] : 0;
        if ($hid > 0) { $ready[$id] = true; continue; }   // satellite: relay-timed
        $ready[$id] = false;                              // until a prompt proves it
        $errno = 0; $errstr = '';
        // Non-blocking connect: returns immediately; readiness is proven by a PROMPT
        // in the bytes below. A refused/down port never becomes readable and ends the
        // wait as not-ready.
        $fp = @stream_socket_client(
            'tcp://' . $n['host'] . ':' . (int) $n['port'],
            $errno, $errstr, 1.5,
            STREAM_CLIENT_CONNECT | STREAM_CLIENT_ASYNC_CONNECT);
        if (!$fp) continue;                               // couldn't even open
        stream_set_blocking($fp, false);
        $conns[$id] = $fp;
        $buf[$id] = '';
    }
    if (empty($conns)) return $ready;
    // Nudge each socket with a CR once its connect completes (writable), then keep
    // reading until it shows a prompt or the shared ~1.5s deadline elapses. ONE
    // stream_select loop covers every node, so the whole gate costs ~one wait.
    $deadline = microtime(true) + 1.5;
    $nudged = [];
    while (!empty($conns) && microtime(true) < $deadline) {
        $w = $conns; $r = $conns; $e = null;
        $n_ready = @stream_select($r, $w, $e, 0, 200000); // 0.2s slices
        if ($n_ready === false) break;
        foreach ($w as $fp) {
            $id = array_search($fp, $conns, true);
            if ($id === false || isset($nudged[$id])) continue;
            @fwrite($fp, "\r\n");                          // wake the line
            $nudged[$id] = true;
        }
        foreach ($r as $fp) {
            $id = array_search($fp, $conns, true);
            if ($id === false) continue;
            $chunk = @fread($fp, 512);
            if ($chunk === '' || $chunk === false) continue;
            // keep only a bounded tail — a prompt lives at the end of the stream.
            $buf[$id] = substr($buf[$id] . $chunk, -512);
            if (ov_console_has_prompt($buf[$id])) {        // real prompt = ready
                $ready[$id] = true;
                @fclose($fp);
                unset($conns[$id]);
            }
        }
    }
    foreach ($conns as $fp) @fclose($fp);                 // no-prompt = not ready
    return $ready;
}

/* Partition a node-row set into [ready, not_ready_names] using the CONCURRENT
   readiness probe. Satellite-placed nodes (host_id>0) are treated as ready without a
   local probe — their console isn't reachable from the master; the relay applies its
   own timeout. Cost is ~1.5s TOTAL for the whole set (one stream_select wait), not
   ~1.5s per not-ready master console. */
function ov_filter_ready($rows) {
    $rmap = ov_console_ready_map($rows);
    $ready = []; $notready = [];
    foreach ($rows as $id => $n) {
        if (!empty($rmap[$id])) {
            $ready[$id] = $n;
        } else {
            $notready[] = $n['name'];
        }
    }
    return [$ready, $notready];
}

/* One read-only show on a node; returns the raw text ('' on any error). For a
   satellite-placed node the read is relayed to its host, where the console is
   local (127.0.0.1). A master-local console is readiness-checked first so a
   not-ready console costs ~1.5s here instead of the full broker timeout. */
function ov_show($n, $cmd) {
    $hid = isset($n['host_id']) ? (int) $n['host_id'] : 0;
    if ($hid === 0 && !ov_console_ready($n['host'], $n['port'])) return '';
    $resp = cluster_broker($hid, 'node_show', [
        'host' => $hid > 0 ? '127.0.0.1' : $n['host'],
        'port' => $n['port'], 'cmd' => $cmd, 'mode' => 'raw',
    ], OV_READ_TIMEOUT);
    if (!$resp['ok']) return '';
    $j = json_decode(implode("\n", $resp['out']), true);
    if (!is_array($j) || isset($j['error'])) return '';
    return isset($j['raw']) ? $j['raw'] : '';
}

/* Classify a node's NOS from its template/image. NX-OS (Nexus 9000v etc.) differs
   from IOS / IOS-XE / IOL in several show outputs — no `show ip cef`,
   `show port-channel summary` instead of `show etherchannel summary`, and
   feature-gated routing protocols. Anything else defaults to 'ios'. */
function ov_node_nos($node) {
    $hint = strtolower((string) $node->getTemplate() . ' ' . (string) $node->getImage());
    // IOS-XR (XRv / XRv9000 / XRd) speaks a different show dialect than IOS/NX-OS
    // (no `show ip cef <pfx>`, different `show ip route`/`show ip bgp`/OSPF layouts),
    // so the overlay parsers don't yet understand it. Classify it explicitly so the
    // routing overlays can SKIP it with a clear per-node warning instead of
    // telnetting it and painting confusing "no data" (F7).
    if (preg_match('/iosxr|xrv9k|xrv|\bxrd\b|xr9k/', $hint)) return 'xr';
    if (preg_match('/nxos|n9k|n7k|nexus|titanium/', $hint)) return 'nxos';
    return 'ios';
}

/* Is this node an L2-capable Cisco SWITCH? STP/RSTP/MST only run on switches, so the
   STP overlays probe ONLY these — telnetting a pure router for spanning-tree is slow
   and yields the "no CDP/LLDP neighbours"/"not a switch" noise the user reported.

   The hard part is IOL: the same `iol` template runs EITHER an L2 image
   (i86bi_Linux-L2-…, the switch) OR an L3 image (i86bi_Linux-…-ADVENTERPRISE…, the
   router), distinguishable only by the image filename. vIOS is the mirror case:
   `vios` = router, `viosl2` = switch.

   Rules (matched on the lowercased template+image hint):
     - explicit switch platforms  -> YES  (l2_iol, viosl2, iosvl2, nxosv9k/nexus/n9k)
     - IOL image tagged L2         -> YES  (`-l2-`, `_l2`, `linux-l2`, `linux_l2`)
     - IOL image tagged L3/router  -> NO   (`-l3-`, `adventerprise`, `advipservices`,
                                            `ipbase`, `-l3v-`)
     - bare `iol`/`i86bi` with no L2/L3 marker -> YES (ambiguous: prefer INCLUDING a
                                            real switch over silently dropping it)
     - pure routers (vios L3, csr, c8000, xrv, xrd, isr, asr) -> NO
   Anything not matched (dockers, VPCS, appliances) -> NO. */
function ov_node_is_switch($hint) {
    // Explicit L2 switch platforms.
    if (preg_match('/\bl2_iol\b|viosl2|iosvl2|nxosv9k|n9k|n7k|nexus|titanium/', $hint)) return true;
    // IOL / i86bi image: decide by the L2/L3 tag baked into the image filename.
    // Order matters: real L2 switch images are named e.g.
    // "i86bi_Linux-L2-Adventerprisek9-ms…" — they carry BOTH an "L2" marker AND
    // "adventerprise" (the feature set), while router images are "…-L3-AdvEnterprise…".
    // So test the L2 marker FIRST; only if absent do we treat an L3/feature marker as
    // "router". Otherwise the switch's own "adventerprise" would misclassify it.
    if (preg_match('/\biol\b|i86bi/', $hint)) {
        if (preg_match('/[-_ ]l2[-_ ]|linux[-_]l2/', $hint)) return true;                            // switch IOL
        if (preg_match('/[-_ ]l3[-_ ]|adventerprise|advipservices|ipbase|advsecurity/', $hint)) return false; // router IOL
        return true;   // ambiguous IOL -> include (conservative: don't drop a real switch)
    }
    // Everything else that reaches here (vios-L3, csr, c8000, xrv, xrd, isr, asr,
    // dockers, VPCS, ...) is not an STP switch.
    return false;
}

/* Is this node a Cisco NOS that the requested overlay should even probe? Telnetting
   into dockers / VPCS / Linux appliances is slow and pointless — they don't speak
   these IOS show commands. STP/RSTP only makes sense on switches; the routing
   overlays (OSPF/BGP/EIGRP/route trace) only on Cisco router/L3 platforms. Matched
   on the template+image hint. $proto 'any' = the union (used for the root picker). */
function ov_node_relevant($hint, $proto) {
    // Cisco routing platforms: IOL, vIOS, vIOS-L2 (SVI), CSR1000v, Catalyst 8000v
    // (incl. c8000vcm SD-WAN cEdge), IOS-XRv / XRv9000, XRd, NX-OS, ASR/ISR images.
    $rtr = '/iol|vios|csr1000|c8000|cat8000|c8kv|xrv9k|xrv|iosxr|xrd|nxos|n9k|n7k|nexus|titanium|asr1|isr4|isr1/';
    // STP/MST: switches only (strict L2 predicate, distinguishes IOL-L2 from IOL-L3).
    if ($proto === 'stp' || $proto === 'mst') return ov_node_is_switch($hint);
    // IOS-XR is a router but the overlay parsers don't understand its show output
    // yet — exclude it from the probe set here (the paint path emits an explicit
    // per-node "not supported" warning so the user knows WHY it's blank).
    if (preg_match('/iosxr|xrv9k|xrv|\bxrd\b|xr9k/', $hint)) return false;
    return (bool) preg_match($rtr, $hint);   // ospf/bgp/eigrp/route + 'any'
}

/* Keep only the rows relevant to $proto. */
function ov_filter_nodes($rows, $proto) {
    $out = [];
    foreach ($rows as $id => $r) {
        if (ov_node_relevant(isset($r['tpl']) ? $r['tpl'] : '', $proto)) $out[$id] = $r;
    }
    return $out;
}

/* Node-ids that have at least one CONNECTED interface (ethernet on a real network,
   or a serial with a peer). A link-less switch (all interfaces network_id 0 / no
   remote) can't be an STP participant — the screenshots show isolated Switch-3..7
   that must not be probed or reported as root bridge. Read straight from the lab
   model (.unl), so it works on a stopped node and needs no console read. */
function ov_connected_node_ids($lab) {
    $connected = [];
    foreach ($lab->getNodes() as $nid => $node) {
        $nid = intval($nid);
        $has = false;
        foreach ($node->getEthernets() as $intf) {
            if (intval($intf->getNetworkId()) > 0) { $has = true; break; }
        }
        if (!$has) {
            try {
                foreach ($node->getSerials() as $intf) {
                    if (intval($intf->getRemoteId()) > 0) { $has = true; break; }
                }
            } catch (Exception $e) { /* node type without serials */ }
        }
        if ($has) $connected[$nid] = true;
    }
    return $connected;
}

/* Pairwise node adjacency from the LAB MODEL — only DEFINITE point-to-point
   cables: a hidden 2-member private bridge, or a serial with a peer. Shared
   (>2-member) segments and clouds/NAT are intentionally excluded (CDP may not
   propagate across them, so their absence from a CDP read is not proof of a
   stale cache). Returns [[a_id,b_id], ...] with a<b. Used to tell a
   pre-convergence CDP cache (missing an inter-switch link that was learned
   only after the pre-warm ran) from a complete one. */
function ov_lab_p2p_pairs($lab) {
    $pairs = [];
    $by_net = [];
    foreach ($lab->getNodes() as $nid => $node) {
        $nid = intval($nid);
        foreach ($node->getEthernets() as $intf) {
            $net = intval($intf->getNetworkId());
            if ($net > 0) $by_net[$net][$nid] = true;
        }
        try {
            foreach ($node->getSerials() as $intf) {
                $rid = intval($intf->getRemoteId());
                if ($rid > 0 && $rid !== $nid) {
                    $a = min($nid, $rid); $b = max($nid, $rid);
                    $pairs["$a-$b"] = [$a, $b];
                }
            }
        } catch (Exception $e) { /* node type without serials */ }
    }
    $networks = $lab->getNetworks();
    foreach ($by_net as $net => $members) {
        $ids = array_keys($members);
        if (count($ids) !== 2) continue;                 // only true p2p cables
        $type = isset($networks[$net]) ? (string) $networks[$net]->getNType() : 'bridge';
        if (strpos($type, 'bridge') !== 0) continue;     // skip cloud/nat/mgmt segments
        sort($ids);
        $pairs[$ids[0] . '-' . $ids[1]] = [$ids[0], $ids[1]];
    }
    return array_values($pairs);
}

/* Keep only rows whose node-id is in the connected set. */
function ov_filter_connected($rows, $connected) {
    $out = [];
    foreach ($rows as $id => $r) {
        if (isset($connected[intval($id)])) $out[$id] = $r;
    }
    return $out;
}

/* NX-OS prints a feature-gated show as `% Invalid command` (feature disabled) or
   `Note: ... process currently not running` / `... not enabled` (feature enabled
   but unconfigured). Blank those so the parser sees "no data for this protocol
   here" and the overlay degrades gracefully, instead of parsing the error text.
   Also catches IOS `% Invalid input`. Safe for the show outputs we use (a real
   table never contains these markers). */
function ov_avail($raw) {
    if ($raw === null) return '';
    if (trim($raw) === '') return '';
    if (preg_match('/%\s*invalid command|invalid input detected|process currently not running|not enabled|feature[^\n]*not enabled|may not be enabled/i', $raw)) {
        return '';
    }
    return $raw;
}

/* Per-node show commands for a protocol, keyed by logical role, chosen by NOS.
   NX-OS deltas: `show ip route <prefix>` is the forwarding truth (no `show ip
   cef`); `show port-channel summary` not `show etherchannel summary`; EIGRP has
   no `all-links` option. CDP / OSPF-if-brief / STP / ip-brief share the command
   across both, but their OUTPUT is parsed per-NOS downstream. */
function ov_proto_cmds($proto, $nos, $prefix, $vlan, $mst_inst) {
    $nx = ($nos === 'nxos');
    $m = ['cdp' => 'show cdp neighbors detail'];
    $fwd = $nx ? ('show ip route ' . $prefix) : ('show ip cef ' . $prefix);
    if ($proto === 'bgp' || $proto === 'route') {
        $m['fwd'] = $fwd;
        // interface-IP map for resolving a recursive next-hop (NX-OS `show ip
        // route` gives the next-hop IP but not the egress interface) to its node.
        $m['ipbrief'] = 'show ip interface brief';
    } elseif ($proto === 'eigrp') {
        $m['eigrp'] = $nx ? 'show ip eigrp topology' : 'show ip eigrp topology all-links';
        $m['fwd'] = $fwd;
        $m['ipbrief'] = 'show ip interface brief';
    } elseif ($proto === 'stp') {
        $m['stp'] = 'show spanning-tree vlan ' . $vlan;
        $m['ec'] = $nx ? 'show port-channel summary' : 'show etherchannel summary';
    } elseif ($proto === 'mst') {
        $m['stp'] = 'show spanning-tree mst ' . $mst_inst;
        $m['ec'] = $nx ? 'show port-channel summary' : 'show etherchannel summary';
    } else { // ospf
        $m['ospf'] = 'show ip ospf interface brief';
    }
    return $m;
}

/* Pipe a JSON bundle through a pure python helper, return the decoded result. */
function ov_run_py($script, $bundle) {
    $desc = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $p = proc_open('python3 ' . escapeshellarg($script), $desc, $pipes,
                   '/opt/unetlab/scripts');
    if (!is_resource($p)) return ['error' => 'cannot launch overlay helper'];
    fwrite($pipes[0], json_encode($bundle));
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]); fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($p);
    $res = json_decode($stdout, true);
    return is_array($res) ? $res : ['error' => 'overlay helper returned no JSON'];
}

/* Read-only `show` reads across many nodes IN PARALLEL (pnet_showmany fans the
   nodes out concurrently; commands within a node stay sequential — single-client
   console). $jobs = [['key'=>id,'host'=>..,'port'=>..,'cmds'=>[...]]].
   Returns {key: {cmd: {raw, error}}}. */
function ov_gather($jobs) {
    if (empty($jobs)) return [];
    // Bucket by owning host: the master (0) runs the helper locally; each
    // satellite runs ITS jobs against its own local consoles via cluster_call.
    // Node-id keys are unique across hosts, so the bucket results union cleanly.
    $buckets = [];
    foreach ($jobs as $j) {
        $h = isset($j['host_id']) ? (int) $j['host_id'] : 0;
        $buckets[$h][] = $j;
    }
    $merged = [];
    foreach ($buckets as $h => $hjobs) {
        $merged += ($h > 0) ? ov_gather_remote($h, $hjobs) : ov_gather_local($hjobs);
    }
    return $merged;
}

/* Local fan-out: the unprivileged pnet_showmany.py helper, run on this host. */
function ov_gather_local($jobs) {
    if (empty($jobs)) return [];
    $desc = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $p = proc_open('python3 /opt/unetlab/scripts/pnet_showmany.py', $desc, $pipes,
                   '/opt/unetlab/scripts');
    if (!is_resource($p)) return [];
    fwrite($pipes[0], json_encode(array_values($jobs)));
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]); fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($p);
    $r = json_decode($out, true);
    return is_array($r) ? $r : [];
}

/* Relay a satellite's jobs to its satd -> brokerd node_show_many (the verb forces
   each read to the satellite's local 127.0.0.1 console). */
function ov_gather_remote($host_id, $jobs) {
    $clean = [];
    foreach ($jobs as $j) {
        $clean[] = ['key' => (string) $j['key'], 'port' => (int) $j['port'],
                    'cmds' => $j['cmds']];
    }
    $resp = cluster_broker($host_id, 'node_show_many', ['jobs' => $clean], 120);
    if (!$resp['ok']) return [];
    $r = json_decode(implode("\n", $resp['out']), true);
    return is_array($r) ? $r : [];
}

/* ---- CDP topology cache + per-session console lock ---------------------------
 * The physical topology (CDP/LLDP neighbours) doesn't change between VLAN
 * selections or re-runs, but reading `show cdp neighbors detail` on every switch
 * is the slowest part of an overlay. So cache it per lab session: the Protocol
 * Painter pre-warms it on open (action=cdp-warm) and every later paint reuses it,
 * reading only the per-VLAN spanning-tree state fresh. A per-session flock
 * serialises console access so the pre-warm and a VLAN-list/paint read never open
 * two telnet sessions to the same single-client console. */
define('OV_CACHE_DIR', '/dev/shm/pnet-overlay');
define('OV_CDP_TTL', 180);   // seconds a cached topology stays usable

function ov_cache_dir() {
    if (!is_dir(OV_CACHE_DIR)) @mkdir(OV_CACHE_DIR, 0777, true);
    return OV_CACHE_DIR;
}
$GLOBALS['ov_lock_fp'] = null;
function ov_lock($session) {
    ov_cache_dir();
    $fp = @fopen(OV_CACHE_DIR . '/gather-' . intval($session) . '.lock', 'c');
    if (!$fp) return;
    $deadline = microtime(true) + 12;
    while (!flock($fp, LOCK_EX | LOCK_NB)) {
        if (microtime(true) > $deadline) break;   // proceed anyway after the cap
        usleep(100000);
    }
    $GLOBALS['ov_lock_fp'] = $fp;                  // held until the PHP process ends
}
function ov_cdp_cache_path($session) { return OV_CACHE_DIR . '/cdp-' . intval($session) . '.json'; }
function ov_cdp_cache_get($session) {
    $f = ov_cdp_cache_path($session);
    if (!is_file($f)) return null;
    $j = json_decode(@file_get_contents($f), true);
    if (!is_array($j) || !isset($j['ts'])) return null;
    if ((time() - intval($j['ts'])) > OV_CDP_TTL) return null;
    return $j;
}
// Merge new cdp/lldp into the cache (keeps coverage from other node sets) + bump ts.
function ov_cdp_cache_put($session, $cdp, $lldp) {
    ov_cache_dir();
    $cur = ov_cdp_cache_get($session);
    $base_cdp  = (is_array($cur) && isset($cur['cdp']))  ? $cur['cdp']  : [];
    $base_lldp = (is_array($cur) && isset($cur['lldp'])) ? $cur['lldp'] : [];
    @file_put_contents(ov_cdp_cache_path($session), json_encode([
        'ts' => time(), 'cdp' => ($cdp + $base_cdp), 'lldp' => ($lldp + $base_lldp),
    ]));
    @chmod(ov_cdp_cache_path($session), 0664);
}

$method = $_SERVER['REQUEST_METHOD'];
$body = null; $action = '';
if ($method !== 'GET') {
    $body = json_decode(file_get_contents('php://input'), true);
    $action = is_array($body) && isset($body['action']) ? $body['action'] : '';
}

try {
    $lab = ov_open_lab($session, $tenant);
    $nodes = ov_console_nodes($lab);
} catch (Exception $e) {
    out(['error' => 'lab open failed: ' . $e->getMessage()], 400);
}

// Running IOS-XR console nodes (captured before the relevance filter drops them),
// so a routing paint can tell the user WHY its XR nodes are blank instead of
// silently omitting them (F7). ov_node_relevant excludes nos='xr' from the probe.
$ov_xr_running = [];
foreach ($nodes as $n) {
    if ((isset($n['nos']) ? $n['nos'] : '') === 'xr') $ov_xr_running[] = $n['name'];
}

// Restrict the probe set to the Cisco NOS templates relevant to the request, so we
// never telnet into dockers / VPCS / appliances (the old behaviour probed every
// running console node — slow on big topologies). STP/MST → switches only; the
// routing overlays → Cisco router/L3 platforms. The root picker (list) and the
// per-protocol gathers each filter to the right set. (rack/rack-traffic read the
// lab XML directly and don't use $nodes.)
if ($method === 'GET' && isset($_GET['list'])) {
    out(['nodes' => array_values(ov_filter_nodes($nodes, 'any'))]);
}
$ov_base_proto = strtok((string) $action, '-');   // 'stp-roots' -> 'stp', etc.
if (in_array($ov_base_proto, ['ospf', 'bgp', 'eigrp', 'route', 'stp', 'mst'], true)) {
    $nodes = ov_filter_nodes($nodes, $ov_base_proto);
}
// Connected-set gate: a node with NO cabled interface (all ethernets network_id 0,
// no serial peer) can't be an STP participant or an overlay neighbour, and probing
// its console is pure latency. For the STP overlays this is a correctness fix too —
// an isolated switch must never be reported as a root bridge. Also applied to the
// shared cdp-warm (a link-less node has no CDP neighbours to discover), so the warm
// set matches the paint set. Routing overlays likewise gain nothing from a link-less
// node. Computed once from the lab model; empty set = unwired lab, leave $nodes as-is
// so the existing "no nodes / <2 nodes" errors still fire with a sensible message.
if (in_array($ov_base_proto, ['ospf', 'bgp', 'eigrp', 'route', 'stp', 'mst'], true)
    || $action === 'cdp-warm') {
    $ov_connected = ov_connected_node_ids($lab);
    if (!empty($ov_connected)) {
        $nodes = ov_filter_connected($nodes, $ov_connected);
    }
}

if (!in_array($action, ['ospf', 'bgp', 'bgp-prefixes', 'eigrp', 'eigrp-prefixes',
                        'route', 'route-prefixes',
                        'stp', 'stp-vlans', 'stp-roots', 'stp-why',
                        'mst', 'mst-instances', 'rack', 'rack-traffic',
                        'cdp-warm'], true)) {
    out(['error' => 'bad action'], 400);
}

// Serialise console access per session for every action that reads consoles, so a
// pre-warm and a paint/VLAN-list read can't collide on a single-client console.
// rack/rack-traffic read the lab XML + sysfs only — no console, no lock.
if (!in_array($action, ['rack', 'rack-traffic'], true)) {
    ov_lock($session);
}

/* ---- cdp-warm: pre-map the CDP/LLDP topology and cache it (Painter on-open) ---
   Reads `show cdp neighbors detail` (LLDP fallback) on every Cisco node once and
   caches it for the session, so the paint that follows a VLAN pick only reads the
   per-VLAN spanning-tree state. Returns immediately with how many were cached. */
if ($action === 'cdp-warm') {
    $warm = ov_filter_nodes($nodes, 'any');           // all Cisco NOS nodes
    // Skip not-ready consoles up front (~1.5s each) so one booting/held console
    // doesn't cost the full ~40s login-wait inside the parallel gather.
    list($warm, ) = ov_filter_ready($warm);
    $jobs = [];
    foreach ($warm as $nid => $n) {
        $jobs[] = ['key' => (string) $nid, 'host' => $n['host'], 'port' => $n['port'],
                   'host_id' => $n['host_id'], 'cmds' => ['show cdp neighbors detail']];
    }
    $g = ov_gather($jobs);
    $cdp = []; $lldp = []; $lldp_jobs = [];
    foreach ($warm as $nid => $n) {
        $k = (string) $nid;
        $cdp[$k] = isset($g[$k]['show cdp neighbors detail']['raw'])
            ? $g[$k]['show cdp neighbors detail']['raw'] : '';
        if (trim($cdp[$k]) === '') {
            $lldp_jobs[] = ['key' => $k, 'host' => $n['host'], 'port' => $n['port'],
                            'host_id' => $n['host_id'], 'cmds' => ['show lldp neighbors detail']];
        }
    }
    if (!empty($lldp_jobs)) {
        $g2 = ov_gather($lldp_jobs);
        foreach ($lldp_jobs as $j) {
            $k = $j['key'];
            $lldp[$k] = isset($g2[$k]['show lldp neighbors detail']['raw'])
                ? $g2[$k]['show lldp neighbors detail']['raw'] : '';
        }
    }
    ov_cdp_cache_put($session, $cdp, $lldp);
    out(['ok' => true, 'cached' => count($cdp)]);
}

/* ---- rack-traffic: live per-interface byte counters for the glow -------------
   Each cabled ethernet interface has a host-side veth tap vunl<session>_<iface_id>
   (the Network Watcher's tap); its kernel rx/tx byte counters are world-readable
   in sysfs, so we read them directly — no capture daemon, no broker. The client
   polls this, deltas the counters, and pulses a port light-green when its link is
   passing traffic. Master-placed nodes only (satellite taps live on their host).
   Keyed "<node_id>/<ifname>" to match the rack faceplate ports. */
if ($action === 'rack-traffic') {
    // up/down follows the NODE run-state (+ admin-suspend), exactly like the
    // canvas colours each interface — the host veth carrier is unreliable on IOL
    // (stays oper-down while forwarding), so we don't use it. The tap is read only
    // for traffic bytes.
    // up/down is known for EVERY node (the master tracks satellite run-state too),
    // so compute it for all nodes; only the traffic byte read is master-local
    // (satellite taps live on their host — a relay can be added later).
    $traf = []; $up = []; $running = false;
    foreach ($lab->getNodes() as $node_id => $node) {
        $hid = (int) cluster_session_host($lab, $node_id);
        $st = intval($node->getStatus());
        $node_up = ($st === 2 || $st === 3);             // running (/ running+locked)
        if ($node_up) $running = true;
        $ns = $node->getSession();
        foreach ($node->getEthernets() as $iface_id => $iface) {
            if (intval($iface->getNetworkId()) <= 0) continue;
            $susp = method_exists($iface, 'getSuspendStatus') ? intval($iface->getSuspendStatus()) : 0;
            $key = intval($node_id) . '/' . $iface->getName();
            $up[$key] = ($node_up && !$susp);
            if ($node_up && $hid === 0) {                 // traffic bytes: master taps only
                $base = '/sys/class/net/vunl' . $ns . '_' . $iface_id;
                if (is_dir($base)) {
                    $rx = (int) @file_get_contents($base . '/statistics/rx_bytes');
                    $tx = (int) @file_get_contents($base . '/statistics/tx_bytes');
                    $traf[$key] = $rx + $tx;
                }
            }
        }
    }
    out(['traffic' => $traf, 'up' => $up, 'running' => $running, 'ts' => microtime(true)]);
}

/* ---- rack: whole-lab rack-view geometry (Topology Overlays sibling) ----------
   Derives the wiring straight from the LAB MODEL (.unl) — every interface's name
   + network_id is already there, so no CDP / console read is needed. Works on a
   stopped lab and covers every node type and link. A hidden two-member private
   bridge is a point-to-point cable; a cloud / NAT / management or any shared
   (>2-member) network becomes a PATCH PANEL named after the network. Serial links
   are point-to-point (remote_id). pnet_racklayout turns it into rack geometry.
   An optional rack_map {key:{rack,location,u}} (key = node id or "net:<net_id>")
   places the units; unmapped devices park in "Unassigned" (no assignment UI yet). */
if ($action === 'rack') {
    $all = $lab->getNodes();
    if (empty($all)) out(['error' => 'this lab has no nodes'], 400);
    $networks = $lab->getNetworks();

    $node_list = [];
    $eth_by_net = [];                 // network_id -> [ {node, ifname} ]
    $serial_pairs = [];               // dedup key -> p2p adjacency
    foreach ($all as $nid => $node) {
        $nid = intval($nid);
        $ifaces = [];
        foreach ($node->getEthernets() as $intf) {
            $name = (string) $intf->getName();
            $net = intval($intf->getNetworkId());
            $connected = ($net > 0 && isset($networks[$net]));
            // admin/suspend state from the lab model (a suspended link is cabled
            // but down) — drives the port's active/suspended/free colour.
            $suspend = method_exists($intf, 'getSuspendStatus')
                ? intval($intf->getSuspendStatus()) : 0;
            $ifaces[] = ['name' => $name, 'connected' => $connected, 'suspend' => $suspend];
            if ($connected) $eth_by_net[$net][] = ['node' => $nid, 'ifname' => $name];
        }
        try {
            foreach ($node->getSerials() as $intf) {
                $name = (string) $intf->getName();
                $rid = intval($intf->getRemoteId());
                $connected = ($rid > 0 && isset($all[$rid]));
                $ifaces[] = ['name' => $name, 'connected' => $connected];
                if ($connected && $rid !== $nid) {
                    $rif = (string) $intf->getRemoteIf();
                    $a = min($nid, $rid); $b = max($nid, $rid);
                    $aif = ($a === $nid) ? $name : $rif;
                    $bif = ($a === $nid) ? $rif : $name;
                    $serial_pairs["$a-$b-$aif-$bif"] =
                        ['a_node' => $a, 'a_if' => $aif, 'b_node' => $b, 'b_if' => $bif];
                }
            }
        } catch (Exception $e) { /* node type without serials */ }
        $node_list[] = ['id' => $nid, 'name' => $node->getName(),
                        'template' => (string) $node->getTemplate(),
                        'image' => (string) $node->getImage(), 'interfaces' => $ifaces];
    }

    // Split ethernet networks: a hidden 2-member private bridge = a cable; a cloud
    // / NAT / management network, or any shared (>2-member) bridge = a patch panel.
    $adjacencies = array_values($serial_pairs);
    $segments = [];
    foreach ($eth_by_net as $net => $members) {
        $type = isset($networks[$net]) ? (string) $networks[$net]->getNType() : 'bridge';
        $name = isset($networks[$net]) ? (string) $networks[$net]->getName() : '';
        $is_bridge = (strpos($type, 'bridge') === 0);
        if ($is_bridge && count($members) === 2 && $members[0]['node'] !== $members[1]['node']) {
            $a = $members[0]; $b = $members[1];
            if ($a['node'] > $b['node']) { $t = $a; $a = $b; $b = $t; }
            $adjacencies[] = ['a_node' => $a['node'], 'a_if' => $a['ifname'],
                              'b_node' => $b['node'], 'b_if' => $b['ifname']];
        } else {
            // A cloud / NAT / management network (type pnet*/nat*, i.e. not a
            // plain bridge) is an EXTERNAL uplink -> its own top patch panel; a
            // shared (>2-member) private bridge is an INTERNAL segment, co-located.
            $segments[] = ['net_id' => intval($net),
                           'name' => ($name !== '') ? $name : ('Net ' . $net),
                           'type' => $type, 'members' => $members,
                           'class' => $is_bridge ? 'internal' : 'external'];
        }
    }

    $rack_map = (isset($body['rack_map']) && is_array($body['rack_map'])) ? $body['rack_map'] : [];
    $res = ov_run_py('/opt/unetlab/scripts/pnet_racklayout.py',
                     ['nodes' => $node_list, 'adjacencies' => $adjacencies,
                      'segments' => $segments, 'rack_map' => $rack_map]);
    if (isset($res['error']) && !isset($res['racks'])) out($res, 502);
    $res['names'] = [];
    foreach ($node_list as $n) $res['names'][$n['id']] = $n['name'];
    out($res);
}

/* Look up a node's real state (for a precise error when it isn't queryable). */
function ov_node_state($lab, $id) {
    foreach ($lab->getNodes() as $nid => $node) {
        if (intval($nid) === $id) {
            return ['name' => $node->getName(), 'status' => intval($node->getStatus()),
                    'console' => $node->getconsole()];
        }
    }
    return null;
}

/* Root = the right-clicked link's near node, falling back to its far node when
   the near one isn't a running console node (e.g. a half-started / consoleless
   node). Keeps "right-click a link -> it works" robust. */
$primary = isset($body['root_node_id']) ? intval($body['root_node_id']) : 0;
$alt = isset($body['alt_root_node_id']) ? intval($body['alt_root_node_id']) : 0;
$root = 0;
foreach ([$primary, $alt] as $cand) {
    if ($cand && isset($nodes[$cand])) { $root = $cand; break; }
}
if ($root === 0) {
    $st = ov_node_state($lab, $primary);
    if ($st === null) {
        out(['error' => "node $primary is not in this lab"], 400);
    } elseif ($st['status'] !== 2 && $st['status'] !== 3) {
        out(['error' => "node '{$st['name']}' is not running — start it, then retry"], 400);
    } else {
        out(['error' => "node '{$st['name']}' has no serial console to query"
             . ($st['console'] ? " (console: {$st['console']})" : "")
             . " — right-click a link between running router consoles"], 400);
    }
}
$root_n = $nodes[$root];

/* ---- bgp-prefixes: list the root's BGP prefixes for the picker ----------- */
if ($action === 'bgp-prefixes') {
    $rhid = isset($root_n['host_id']) ? (int) $root_n['host_id'] : 0;
    $resp = cluster_broker($rhid, 'node_show', [
        'host' => $rhid > 0 ? '127.0.0.1' : $root_n['host'], 'port' => $root_n['port'],
        'cmd' => 'show ip bgp', 'mode' => 'bgp-table',
    ], 75);
    if (!$resp['ok']) out(['error' => 'broker: ' . $resp['err']], 502);
    $j = json_decode(implode("\n", $resp['out']), true);
    if (!is_array($j)) out(['error' => 'console read returned no parseable output'], 502);
    if (isset($j['error']) && empty($j['picker'])) {
        out(['error' => $j['error'], 'node' => ['node_id' => $root, 'name' => $root_n['name']]], 502);
    }
    out(['node' => ['node_id' => $root, 'name' => $root_n['name']],
         'prefixes' => isset($j['picker']) ? $j['picker'] : []]);
}

/* ---- eigrp-prefixes: list the root's EIGRP topology prefixes for the picker --
   One raw `show ip eigrp topology` read (the default table already holds every
   successor/feasible-successor route); the pure helper parses it into a list. */
if ($action === 'eigrp-prefixes') {
    $raw = ov_show($root_n, 'show ip eigrp topology');
    if (trim($raw) === '') {
        out(['error' => "could not read EIGRP topology from {$root_n['name']} — "
             . 'is EIGRP running, and is its serial console free?',
             'node' => ['node_id' => $root, 'name' => $root_n['name']]], 502);
    }
    $res = ov_run_py('/opt/unetlab/scripts/pnet_routeoverlay.py',
                     ['proto' => 'eigrp-prefixes', 'topo_raw' => $raw]);
    out(['node' => ['node_id' => $root, 'name' => $root_n['name']],
         'prefixes' => isset($res['prefixes']) ? $res['prefixes'] : []]);
}

/* ---- route-prefixes: every prefix in the root's routing table (ANY protocol)
   for the protocol-agnostic Route-Path picker. `show ip route` is the same
   command on IOS + NX-OS; parse_route_table auto-detects the layout. --------- */
if ($action === 'route-prefixes') {
    $raw = ov_show($root_n, 'show ip route');
    if (trim($raw) === '') {
        out(['error' => "could not read the routing table from {$root_n['name']} — "
             . 'is its serial console free?',
             'node' => ['node_id' => $root, 'name' => $root_n['name']]], 502);
    }
    $res = ov_run_py('/opt/unetlab/scripts/pnet_routeoverlay.py',
                     ['proto' => 'route-prefixes', 'topo_raw' => $raw]);
    out(['node' => ['node_id' => $root, 'name' => $root_n['name']],
         'prefixes' => isset($res['prefixes']) ? $res['prefixes'] : []]);
}

/* ---- stp-vlans: list the VLANs with a spanning-tree instance on the node ----
   One `show spanning-tree` read; the pure helper pulls the VLANxxxx ids out. */
if ($action === 'stp-vlans') {
    $raw = ov_show($root_n, 'show spanning-tree');
    if (trim($raw) === '') {
        out(['error' => "could not read spanning-tree from {$root_n['name']} — "
             . 'is STP running on a switch node, and is its console free?',
             'node' => ['node_id' => $root, 'name' => $root_n['name']]], 502);
    }
    $res = ov_run_py('/opt/unetlab/scripts/pnet_routeoverlay.py',
                     ['proto' => 'stp-vlans', 'stp_raw' => $raw]);
    out(['node' => ['node_id' => $root, 'name' => $root_n['name']],
         'vlans' => isset($res['vlans']) ? $res['vlans'] : []]);
}

/* ---- stp-roots: per-VLAN root bridge across ALL nodes (comparison table) ----
   Gathers `show spanning-tree` on every running console node in parallel; the
   helper resolves each VLAN's root bridge to a canvas node. No topomap needed. */
if ($action === 'stp-roots') {
    // Only read consoles that answer a fast readiness probe; a not-ready one costs
    // ~1.5s instead of stalling the parallel gather ~40s.
    list($rr, ) = ov_filter_ready($nodes);
    $jobs = []; $nlist = [];
    foreach ($rr as $nid => $n) {
        $nlist[] = ['id' => $nid, 'name' => $n['name']];
        $jobs[] = ['key' => (string) $nid, 'host' => $n['host'], 'port' => $n['port'],
                   'host_id' => $n['host_id'], 'cmds' => ['show spanning-tree']];
    }
    $g = ov_gather($jobs);
    $stp = [];
    foreach ($rr as $nid => $n) {
        $k = (string) $nid;
        $stp[$k] = isset($g[$k]['show spanning-tree']['raw']) ? $g[$k]['show spanning-tree']['raw'] : '';
    }
    $res = ov_run_py('/opt/unetlab/scripts/pnet_routeoverlay.py',
                     ['proto' => 'stp-roots', 'nodes' => $nlist, 'stp' => $stp]);
    out(['roots' => isset($res['roots']) ? $res['roots'] : [],
         'names' => isset($res['names']) ? $res['names'] : []]);
}

/* ---- stp-why: why one port blocks (BPDU from the designated bridge) ----------
   One `show spanning-tree vlan <id> interface <if> detail` on the blocked node. */
if ($action === 'stp-why') {
    $vlan = isset($body['vlan']) ? trim((string) $body['vlan']) : '';
    $iface = isset($body['iface']) ? trim((string) $body['iface']) : '';
    if (!preg_match('#^\d{1,4}$#', $vlan)) out(['error' => 'bad vlan'], 400);
    if (!preg_match('#^[A-Za-z][A-Za-z0-9/.:-]*$#', $iface)) out(['error' => 'bad iface'], 400);
    // `vlan X interface Y` is NOT valid IOS — read the whole-VLAN (or whole-MST-
    // instance) detail and let the helper pick this port's block.
    $cmd = !empty($body['mst']) ? "show spanning-tree mst $vlan detail"
                                : "show spanning-tree vlan $vlan detail";
    $raw = ov_show($root_n, $cmd);
    if (trim($raw) === '') {
        out(['error' => "could not read STP detail from {$root_n['name']} "
             . '— console busy?', 'node' => ['node_id' => $root, 'name' => $root_n['name']]], 502);
    }
    $res = ov_run_py('/opt/unetlab/scripts/pnet_routeoverlay.py',
                     ['proto' => 'stp-why', 'why_raw' => $raw, 'iface' => $iface]);
    out(['why' => isset($res['why']) ? $res['why'] : null,
         'node' => ['node_id' => $root, 'name' => $root_n['name']]]);
}

/* ---- mst-instances: list MST instances (+ region) for the MST picker --------
   One `show spanning-tree mst configuration` read on the root node. */
if ($action === 'mst-instances') {
    $raw = ov_show($root_n, 'show spanning-tree mst configuration');
    if (trim($raw) === '') {
        out(['error' => "could not read MST config from {$root_n['name']} — is this "
             . 'switch in MST mode (spanning-tree mode mst), and is its console free?',
             'node' => ['node_id' => $root, 'name' => $root_n['name']]], 502);
    }
    $res = ov_run_py('/opt/unetlab/scripts/pnet_routeoverlay.py',
                     ['proto' => 'mst-instances', 'mst_raw' => $raw]);
    out(['node' => ['node_id' => $root, 'name' => $root_n['name']],
         'region' => isset($res['region']) ? $res['region'] : null,
         'revision' => isset($res['revision']) ? $res['revision'] : null,
         'instances' => isset($res['instances']) ? $res['instances'] : []]);
}

if (count($nodes) < 2) out(['error' => 'need at least 2 running console nodes for an overlay'], 400);

$proto = ($action === 'bgp') ? 'bgp' : (($action === 'route') ? 'route'
         : (($action === 'eigrp') ? 'eigrp'
         : (($action === 'stp') ? 'stp' : (($action === 'mst') ? 'mst' : 'ospf'))));
$prefix = '';
if ($proto === 'bgp' || $proto === 'route' || $proto === 'eigrp') {
    $prefix = isset($body['prefix']) ? trim((string) $body['prefix']) : '';
    if (!preg_match('#^\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?$#', $prefix)) {
        out(['error' => 'bad prefix'], 400);
    }
}
$vlan = '';
if ($proto === 'stp') {
    $vlan = isset($body['vlan']) ? trim((string) $body['vlan']) : '';
    if (!preg_match('#^\d{1,4}$#', $vlan)) out(['error' => 'bad vlan'], 400);
}
$mst_inst = '';
if ($proto === 'mst') {
    $mst_inst = isset($body['mst_inst']) ? trim((string) $body['mst_inst']) : '';
    if (!preg_match('#^\d{1,3}$#', $mst_inst)) out(['error' => 'bad mst instance'], 400);
}

/* Gather neighbour discovery + the per-protocol forwarding data from every
   running node IN PARALLEL (CDP everywhere; OSPF interface cost, CEF for a BGP
   prefix, or BOTH the EIGRP topology table AND CEF for an EIGRP prefix — CEF is
   the variance-aware forwarding truth, the topology supplies the S/FS role).
   One job per node = [CDP, ...proto-cmds], run concurrently across nodes. */
// Per-node command sets, chosen by each node's NOS (ov_proto_cmds): NX-OS swaps
// `show ip cef`->`show ip route`, `show etherchannel`->`show port-channel`, and
// has no EIGRP `all-links`. EIGRP also reads `show ip interface brief` for an
// IP->node map (off-canvas next-hops). Every read is run through ov_avail() so a
// feature-gated NX-OS node contributes NO data (graceful degrade) rather than
// having its "% Invalid command" / "process not running" text parsed.
$node_cmds = [];
$node_list = []; $cdp = []; $lldp = []; $ospf_if = []; $cef = []; $eigrp = [];
$ipbrief = []; $stp = []; $ec = []; $nos_map = [];
$unread = [];
$jobs = [];
// Fast readiness pre-check (master-local consoles only): a booting / held console
// accepts TCP but never emits a prompt, so its full node_show would stall the
// parallel gather ~40s. Probe ALL nodes CONCURRENTLY (one stream_select wait,
// ~1.5s total for the whole set — not ~1.5s per node in series) and issue NO gather
// job for a not-ready node — it stays in the topology model (node_list/correlation)
// and falls through to the $unread warning below exactly as an empty read would, but
// the whole gate costs ~one wait. Satellite nodes (host_id>0) are relayed and skip
// the local probe (reported ready by ov_console_ready_map).
$ready_map = ov_console_ready_map($nodes);
// CDP/LLDP topology cache (pre-warmed by the Painter on open, or by an earlier
// paint). Usable only if it's fresh AND covers every node we're about to map.
$cache = ov_cdp_cache_get($session);
$use_cdp_cache = is_array($cache) && isset($cache['cdp']);
if ($use_cdp_cache) {
    foreach ($nodes as $nid => $n) {
        if (!isset($cache['cdp'][(string) $nid])) { $use_cdp_cache = false; break; }
    }
}
// Convergence guard (beyond node-key presence): the pre-warm on painter-open can
// cache a switch's CDP before it has learned its inter-switch peers, so a link
// that converges a few seconds later is absent from the cache and gets silently
// dropped from every paint for the whole TTL (user-reported: the STP painter
// skipped the late-converging spoke links, e.g. SW4/SW5). For each DIRECT p2p
// cable the lab defines between two probed nodes, require the cached CDP to
// witness it in at least one direction; if a cabled pair is wholly absent from
// the cache, treat the cache as pre-convergence and re-gather CDP fresh this pass
// (the fresh read then re-caches complete, so later paints reuse it again).
if ($use_cdp_cache) {
    $probe_names = [];
    foreach ($nodes as $nid => $n) {
        $probe_names[(string) $nid] = trim((string) (isset($n['name']) ? $n['name'] : ''));
    }
    $ov_cdp_mentions = function ($text, $name) {
        return $name !== '' && stripos((string) $text, $name) !== false;
    };
    foreach (ov_lab_p2p_pairs($lab) as $pair) {
        $ak = (string) $pair[0]; $bk = (string) $pair[1];
        if (!isset($probe_names[$ak]) || !isset($probe_names[$bk])) continue; // not both probed
        $a_sees_b = isset($cache['cdp'][$ak]) && $ov_cdp_mentions($cache['cdp'][$ak], $probe_names[$bk]);
        $b_sees_a = isset($cache['cdp'][$bk]) && $ov_cdp_mentions($cache['cdp'][$bk], $probe_names[$ak]);
        if (!$a_sees_b && !$b_sees_a) { $use_cdp_cache = false; break; }
    }
}
foreach ($nodes as $nid => $n) {
    $node_list[] = ['id' => $nid, 'name' => $n['name']];
    $nos_map[(string) $nid] = isset($n['nos']) ? $n['nos'] : 'ios';
    $cm = ov_proto_cmds($proto, $nos_map[(string) $nid], $prefix, $vlan, $mst_inst);
    $node_cmds[$nid] = $cm;
    // Not-ready master console: don't issue a gather job (would stall ~40s). It
    // still participates in topology correlation and gets flagged $unread below.
    if (empty($ready_map[$nid])) continue;
    // Skip the (slow) CDP read when the cached topology covers this node — only the
    // per-protocol state commands are read fresh.
    $cmds = [];
    foreach ($cm as $ckey => $c) {
        if ($ckey === 'cdp' && $use_cdp_cache) continue;
        $cmds[] = $c;
    }
    if (!empty($cmds)) {
        $jobs[] = ['key' => (string) $nid, 'host' => $n['host'], 'port' => $n['port'],
                   'host_id' => $n['host_id'], 'cmds' => array_values($cmds)];
    }
}
$g = ov_gather($jobs);
$raw = function ($k, $cmd) use ($g) {
    return isset($g[$k][$cmd]['raw']) ? $g[$k][$cmd]['raw'] : '';
};

$lldp_jobs = [];
foreach ($nodes as $nid => $n) {
    $k = (string) $nid;
    $cm = $node_cmds[$nid];
    $cdp[$k] = $use_cdp_cache
        ? ov_avail((string) $cache['cdp'][$k])
        : ov_avail($raw($k, $cm['cdp']));
    if ($proto === 'bgp' || $proto === 'route')
                                 { $cef[$k] = ov_avail($raw($k, $cm['fwd']));
                                   $ipbrief[$k] = ov_avail($raw($k, $cm['ipbrief'])); }
    elseif ($proto === 'eigrp')  { $eigrp[$k] = ov_avail($raw($k, $cm['eigrp']));
                                   $cef[$k] = ov_avail($raw($k, $cm['fwd']));
                                   $ipbrief[$k] = ov_avail($raw($k, $cm['ipbrief'])); }
    elseif ($proto === 'stp')    { $stp[$k] = ov_avail($raw($k, $cm['stp']));
                                   $ec[$k] = ov_avail($raw($k, $cm['ec'])); }
    elseif ($proto === 'mst')    { $stp[$k] = ov_avail($raw($k, $cm['stp']));
                                   $ec[$k] = ov_avail($raw($k, $cm['ec'])); }
    else                         $ospf_if[$k] = ov_avail($raw($k, $cm['ospf']));
    // No CDP -> LLDP fallback. From cache when we're using the cached topology
    // (the pre-warm already did the LLDP fallback); else queue a parallel read —
    // but NOT for a not-ready console (its LLDP read would stall ~40s too).
    if (trim($cdp[$k]) === '') {
        if ($use_cdp_cache) {
            $lldp[$k] = isset($cache['lldp'][$k]) ? (string) $cache['lldp'][$k] : '';
        } elseif (!empty($ready_map[$nid])) {
            $lldp_jobs[] = ['key' => $k, 'host' => $n['host'], 'port' => $n['port'],
                            'host_id' => $n['host_id'],
                            'cmds' => ['show lldp neighbors detail']];
        }
    }
}
if (!empty($lldp_jobs)) {
    $g2 = ov_gather($lldp_jobs);
    foreach ($lldp_jobs as $j) {
        $k = $j['key'];
        $lldp[$k] = isset($g2[$k]['show lldp neighbors detail']['raw'])
            ? $g2[$k]['show lldp neighbors detail']['raw'] : '';
    }
}
// Freshly gathered the topology this time -> cache it for the next paint/re-run.
// Only cache non-empty reads: a not-ready console yields '' this pass, and the
// merge in ov_cdp_cache_put keeps the NEW value for a shared key, so writing ''
// would clobber a previously-good cached entry. Dropping empties lets the older
// good topology survive (it's TTL-bounded anyway).
if (!$use_cdp_cache) {
    $cdp_put = array_filter($cdp, function ($v) { return trim((string) $v) !== ''; });
    $lldp_put = array_filter($lldp, function ($v) { return trim((string) $v) !== ''; });
    if (!empty($cdp_put) || !empty($lldp_put)) {
        ov_cdp_cache_put($session, $cdp_put, $lldp_put);
    }
}
foreach ($nodes as $nid => $n) {
    $k = (string) $nid;
    $pc = ($proto === 'bgp' || $proto === 'route') ? (isset($cef[$k]) ? $cef[$k] : '')
        : (($proto === 'eigrp') ? (isset($eigrp[$k]) ? $eigrp[$k] : '')
        : (($proto === 'stp' || $proto === 'mst') ? (isset($stp[$k]) ? $stp[$k] : '')
                                : (isset($ospf_if[$k]) ? $ospf_if[$k] : '')));
    // Nothing from any read: the serial console is single-client, so an open
    // web console on this node blocks our read.
    if (trim($cdp[$k]) === '' && trim(isset($lldp[$k]) ? $lldp[$k] : '') === ''
        && trim($pc) === '') {
        $unread[] = $n['name'];
    }
}

// MST: one extra read on the root for the region name/revision (legend).
$mst_cfg = ($proto === 'mst') ? ov_show($root_n, 'show spanning-tree mst configuration') : '';
// OSPF truth-source guard: one extra read on the root — its ACTUAL OSPF routing
// table — so pnet_routeoverlay can cross-check the computed SPF first hops against
// the router's real RIB and flag any that diverge (F1).
$ospf_rib = ($proto === 'ospf') ? ov_avail(ov_show($root_n, 'show ip route ospf')) : '';
$bundle = [
    'proto' => $proto, 'root' => $root, 'prefix' => $prefix, 'vlan' => $vlan,
    'mst_inst' => $mst_inst, 'mst_cfg' => $mst_cfg, 'ospf_rib' => $ospf_rib,
    'nodes' => $node_list, 'nos' => $nos_map,
    'cdp' => $cdp, 'lldp' => $lldp, 'ospf_if' => $ospf_if, 'cef' => $cef,
    'eigrp' => $eigrp, 'ipbrief' => $ipbrief, 'stp' => $stp, 'ec' => $ec,
];
$res = ov_run_py('/opt/unetlab/scripts/pnet_routeoverlay.py', $bundle);
if (isset($res['error']) && !isset($res['edges'])) out($res, 502);

// Quiet the "unmapped neighbour '<x>' seen from <y>" warnings for nodes we
// DELIBERATELY excluded from the probe set. After the switch/connected scoping,
// STP probes only wired switches — so a switch's CDP/LLDP table still lists its
// router / link-less neighbours (R5, an isolated Switch, ...), and the topomap,
// which only knows the probed set, flags each as "unmapped". Those aren't errors:
// the node exists in the lab, we just chose not to probe it. So suppress a warning
// whose unmapped neighbour is a real lab node that ISN'T in the probe set, and fold
// the suppressed names into a single non-alarming note. A neighbour that matches NO
// lab node (or one we DID probe) is genuinely unexpected and stays visible.
if (!empty($res['warnings']) && is_array($res['warnings'])) {
    // All lab node names (the full universe) vs the names we actually probed.
    $all_names = [];
    foreach ($lab->getNodes() as $ln) {
        $nm = strtolower(trim((string) $ln->getName()));
        if ($nm !== '') $all_names[$nm] = true;
    }
    $probed_names = [];
    foreach ($nodes as $pn) {
        $nm = strtolower(trim((string) $pn['name']));
        if ($nm !== '') $probed_names[$nm] = true;
    }
    $kept = []; $excluded_seen = [];
    foreach ($res['warnings'] as $w) {
        if (preg_match("/unmapped neigh\\w+ '([^']+)'/i", $w, $m)) {
            // The neighbour hostname CDP/LLDP advertised — a switch's IOS hostname
            // usually equals its canvas node name (the "R5"/"Switch" case). Match it
            // against the lab node set; strip any DNS suffix a NOS may append.
            $nbr = strtolower(trim($m[1]));
            $nbr_short = strtok($nbr, '.');
            $is_lab_node = isset($all_names[$nbr]) || isset($all_names[$nbr_short]);
            $was_probed  = isset($probed_names[$nbr]) || isset($probed_names[$nbr_short]);
            if ($is_lab_node && !$was_probed) {
                $excluded_seen[$m[1]] = true;   // intentionally excluded -> hide
                continue;
            }
        }
        $kept[] = $w;   // not an unmapped-neighbour warning, or a genuine surprise
    }
    if (!empty($excluded_seen)) {
        // One aggregated, non-alarming note instead of a per-neighbour warning wall.
        $kept[] = count($excluded_seen) . ' neighbour'
            . (count($excluded_seen) > 1 ? 's' : '')
            . ' not in the probe set (' . implode(', ', array_keys($excluded_seen))
            . ') — excluded by the switch/connected filters, not read';
    }
    $res['warnings'] = $kept;
}

if (!empty($unread)) {
    $res['warnings'][] = 'could not read ' . implode(', ', $unread)
        . ' — the serial console is single-client; close its web console and retry';
}
// IOS-XR nodes were deliberately not probed (parsers don't understand XR show
// output yet) — tell the user explicitly for a routing paint so blank XR nodes
// aren't a mystery.
if (!empty($ov_xr_running)
    && in_array($proto, ['ospf', 'bgp', 'eigrp', 'route'], true)) {
    $res['warnings'][] = 'IOS-XR ' . (count($ov_xr_running) > 1 ? 'nodes' : 'node')
        . ' ' . implode(', ', $ov_xr_running)
        . ' not supported by the overlays yet — not read (XR show output differs '
        . 'from IOS/NX-OS)';
}
$adj_n = isset($res['adjacencies']) ? count($res['adjacencies']) : 0;
if ($adj_n === 0) {
    $res['warnings'][] = 'no inter-node links discovered — enable `cdp run` '
        . '(or `lldp run`) on the nodes (or their consoles are busy, see above)';
} elseif ($proto === 'ospf') {
    $in_tree = 0;
    foreach ($res['edges'] as $e) if (!empty($e['in_tree'])) $in_tree++;
    if ($in_tree === 0) {
        $res['warnings'][] = 'no OSPF SPF tree computed — OSPF not detected on '
            . 'these nodes (showing the discovered topology only)';
    }
} elseif ($proto === 'bgp' || $proto === 'route') {
    $in_path = 0;
    foreach ($res['edges'] as $e) if (!empty($e['in_path'])) $in_path++;
    if ($in_path === 0) {
        $res['warnings'][] = "no forwarding path for $prefix from "
            . "{$root_n['name']} — the prefix may not be in its table, or the "
            . 'next hop leaves via a link not on this canvas';
    }
} elseif ($proto === 'eigrp') {
    $fwd = 0;
    foreach ($res['edges'] as $e) if (!empty($e['forwarding'])) $fwd++;
    $offc = isset($res['offcanvas']) ? $res['offcanvas'] : [];
    if ($fwd === 0 && empty($offc)) {
        $res['warnings'][] = "no EIGRP forwarding path for $prefix from "
            . "{$root_n['name']} — the prefix may not be in its topology table, "
            . 'or its successor exits via a link not on this canvas';
    } elseif ($fwd === 0 && !empty($offc)) {
        // The path exists but leaves the canvas (DMVPN tunnel / off-canvas peer);
        // the legend lists the exits, so keep this short and specific.
        $res['warnings'][] = "the forwarding path for $prefix leaves the canvas "
            . '(see “Off-canvas exits” below) — those next-hops aren’t drawable links';
    }
} else {   // stp or mst
    $roled = 0;
    foreach ($res['edges'] as $e) {
        if (!empty($e['forwarding']) || !empty($e['blocked'])
            || !empty($e['transitioning'])) $roled++;
    }
    if ($roled === 0) {
        $what = ($proto === 'mst') ? "MST instance $mst_inst" : "VLAN $vlan";
        // Routers and link-less switches are already excluded from the probe set, so
        // this is a real "no STP here" on the connected switches we did read.
        $res['warnings'][] = "no spanning-tree port roles for $what on the connected "
            . 'switches — STP may not be running for it, the instance/VLAN may not '
            . 'exist, or those switch consoles are busy';
    }
}
out($res);
