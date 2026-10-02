/**
 * pnetlab-roce-lab.js — native RXE endpoint inventory and health workspace.
 *
 * Inventory remains independently usable. Run Pair adds one bounded,
 * ordered rping -> write-latency -> write-bandwidth lifecycle.
 */
(function () {
  'use strict';

  var API = '/pnq-roce.php';
  var root = null, opener = null, minimizedControl = null, pollTimer = 0, inventoryTimer = 0;
  var nodes = [], healthById = {}, polling = false, generation = 0;
  var sequenceToken = 0, workloadTimer = 0, activeTab = 'inventory', activeGuide = 'readiness';
  var TOOLS = ['rping', 'ib_write_lat', 'ib_write_bw'];
  var GUIDES = [
    { id: 'readiness', title: 'Reachability vs readiness', summary: 'Separate IP, RXE and RDMA-CM evidence.' },
    { id: 'routing', title: 'Addressing and routing', summary: 'Localize subnet, gateway, route and MTU mistakes.' },
    { id: 'lifecycle', title: 'Completion and cleanup', summary: 'Read pass, cancel, timeout and cleanup states.' },
    { id: 'capture', title: 'Read RoCEv2 packets', summary: 'Capture the guest fabric and filter UDP/4791.' }
  ];
  var run = newRun();
  var LIMIT = 'Functional software-RoCE result. Not representative of RNIC offload, ' +
    'ASIC buffering, PFC propagation, DCQCN firmware response, GPUDirect RDMA, or ' +
    'production latency and throughput.';

  function newRun() {
    return { active: false, cancelling: false, cancelSent: false, cancelPending: false, blocked: false,
      phase: 'idle', toolIndex: -1, runId: '', serverId: '', clientId: '',
      evidence: null, resultsExpanded: false, error: '', notice: '', stages: TOOLS ? TOOLS.map(function (tool) {
        return { tool: tool, state: 'pending' };
      }) : [] };
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[<>&"']/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function injectCss() {
    if (document.getElementById('pnq-roce-css')) return;
    var style = document.createElement('style');
    style.id = 'pnq-roce-css';
    style.textContent =
      '#pnq-roce-modal{position:fixed;inset:0;z-index:100080;display:flex;align-items:center;' +
      'justify-content:center;padding:24px;background:rgba(8,11,16,.72);font:13px/1.45 -apple-system,' +
      'BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e8edf5}' +
      '#pnq-roce-modal[hidden]{display:none!important}' +
      '#pnq-roce-dialog{width:min(1120px,96vw);max-height:min(820px,92vh);display:flex;flex-direction:column;' +
      'overflow:hidden;background:#171c24;border:1px solid #354052;border-radius:10px;' +
      'box-shadow:0 18px 54px rgba(0,0,0,.55)}' +
      '#pnq-roce-head{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid #303a49}' +
      '#pnq-roce-head h2{font-size:19px;line-height:1.2;margin:0;color:#f6f8fb;font-weight:650}' +
      '#pnq-roce-head .pnq-roce-sub{color:#aab6c7;margin-top:3px}' +
      '#pnq-roce-head .pnq-roce-spacer{flex:1}' +
      '.pnq-roce-iconbtn{width:34px;height:34px;border:1px solid #465267;border-radius:7px;' +
      'background:#202733;color:#dce4ef;cursor:pointer}' +
      '.pnq-roce-iconbtn:hover{background:#293343;border-color:#66748c}' +
      '#pnq-roce-minimized{position:fixed;right:20px;bottom:20px;z-index:100080;display:flex;align-items:center;gap:9px;' +
      'max-width:min(360px,calc(100vw - 24px));padding:10px 14px;border:1px solid #52627a;border-radius:9px;' +
      'background:#202733;color:#eef3f9;box-shadow:0 10px 30px rgba(0,0,0,.48);cursor:pointer;font:600 13px/1.3 -apple-system,' +
      'BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
      '#pnq-roce-minimized:hover{background:#293343;border-color:#6d7f99}#pnq-roce-minimized .pnq-roce-mini-state{color:#9ce8bf;font-weight:500}' +
      '#pnq-roce-minimized:focus-visible{outline:3px solid #69a8ff;outline-offset:2px}' +
      '.pnq-roce-iconbtn:focus-visible,.pnq-roce-retry:focus-visible,.pnq-roce-tab:focus-visible,' +
      '.pnq-roce-button:focus-visible,.pnq-roce-field select:focus-visible,.pnq-roce-output:focus-visible{' +
      'outline:3px solid #69a8ff;outline-offset:2px}' +
      '#pnq-roce-summary{display:flex;gap:20px;align-items:center;min-height:44px;padding:10px 18px;' +
      'background:#121720;border-bottom:1px solid #303a49;color:#b8c3d2}' +
      '.pnq-roce-count{font-variant-numeric:tabular-nums;color:#f3f6fa;font-weight:600}' +
      '.pnq-roce-updated{margin-left:auto;color:#8f9bad;font-variant-numeric:tabular-nums}' +
      '#pnq-roce-body{overflow:auto;min-height:250px;max-height:64vh}' +
      '#pnq-roce-body table{width:100%;border-collapse:collapse;table-layout:fixed}' +
      '#pnq-roce-body th{position:sticky;top:0;z-index:1;padding:9px 12px;text-align:left;' +
      'background:#202733;color:#aeb9c9;border-bottom:1px solid #3b4658;font-size:11px;' +
      'letter-spacing:.035em;text-transform:uppercase}' +
      '#pnq-roce-body td{padding:11px 12px;vertical-align:top;border-bottom:1px solid #293240;' +
      'background:#171c24!important;color:#dce4ef;word-break:break-word;font-variant-numeric:tabular-nums}' +
      '#pnq-roce-body tbody tr:hover>td{background:#1c2430!important;color:#e8edf5!important}' +
      '.pnq-roce-name{font-weight:650;color:#f2f5f9}.pnq-roce-meta{display:block;color:#8997aa;font-size:11px;margin-top:2px}' +
      '.pnq-roce-state{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}' +
      '.pnq-roce-dot{width:8px;height:8px;border-radius:50%;background:#7e8998}' +
      '.pnq-roce-state.ok .pnq-roce-dot{background:#42ce85}.pnq-roce-state.ok{color:#9ce8bf}' +
      '.pnq-roce-state.bad .pnq-roce-dot{background:#ec6c75}.pnq-roce-state.bad{color:#ffb5ba}' +
      '.pnq-roce-state.wait .pnq-roce-dot{background:#e2b354}.pnq-roce-state.wait{color:#f1d28e}' +
      '.pnq-roce-muted{color:#8997aa}.pnq-roce-empty{padding:52px 24px;text-align:center;color:#aab5c4}' +
      '.pnq-roce-empty i{display:block;font-size:28px;color:#77869a;margin-bottom:12px}' +
      '.pnq-roce-error{margin:16px;padding:12px 14px;border:1px solid #7f3f47;border-radius:7px;' +
      'background:#351f25;color:#ffd1d5}' +
      '.pnq-roce-retry{margin-left:10px;border:1px solid #90626a;border-radius:5px;background:#4b2b32;' +
      'color:#fff;padding:4px 9px;cursor:pointer}' +
      '.pnq-roce-tabs{display:flex;gap:4px;padding:8px 18px 0;background:#121720}' +
      '.pnq-roce-tab,.pnq-roce-button{border:1px solid #465267;border-radius:7px;background:#202733;color:#dce4ef;cursor:pointer;padding:8px 13px}' +
      '.pnq-roce-tab[aria-selected=true]{background:#2b3544;color:#fff}.pnq-roce-button.primary{background:#276b49;border-color:#3b9669;color:#fff}' +
      '.pnq-roce-button.danger{background:#5a2d35;border-color:#9a4b58}.pnq-roce-button.recover{border-color:#66748c}.pnq-roce-button[disabled],select[disabled]{opacity:.5;cursor:not-allowed}' +
      '.pnq-roce-panel[hidden]{display:none!important}#pnq-roce-run{padding:16px 18px}' +
      '.pnq-roce-form{display:grid;grid-template-columns:1fr 1fr auto auto auto;gap:10px;align-items:end}' +
      '.pnq-roce-field label{display:block;margin-bottom:5px;color:#b8c3d2;font-weight:600}.pnq-roce-field select{width:100%;min-height:35px;padding:6px 9px;border:1px solid #465267;border-radius:6px;background:#111722;color:#eef3f9}' +
      '.pnq-roce-runstatus{display:flex;align-items:center;gap:12px;margin:14px 0;padding:10px 12px;border:1px solid #354052;border-radius:7px;background:#121720}' +
      '.pnq-roce-runstatus-main{min-width:0}.pnq-roce-results-open{margin-left:auto;white-space:nowrap}' +
      '.pnq-roce-stages{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0;padding:0;list-style:none}.pnq-roce-stages li{padding:9px 10px;border-left:3px solid #596679;background:#202733}.pnq-roce-stages li.ok{border-color:#42ce85}.pnq-roce-stages li.bad{border-color:#ec6c75}.pnq-roce-stages li.wait{border-color:#e2b354}' +
      '.pnq-roce-evidence{display:grid;grid-template-columns:1fr 1fr;gap:10px}.pnq-roce-role{min-width:0;padding:10px;border:1px solid #354052;border-radius:7px;background:#121720}.pnq-roce-role h3{margin:0 0 7px;font-size:13px}.pnq-roce-role dl{display:grid;grid-template-columns:auto 1fr;gap:3px 9px;margin:0}.pnq-roce-role dt{color:#8f9bad}.pnq-roce-role dd{margin:0;word-break:break-word}.pnq-roce-output{max-height:150px;overflow:auto;white-space:pre-wrap;padding:8px;background:#0c1118;border:1px solid #293240;color:#cbd5e2;scrollbar-color:#52627a #0c1118;scrollbar-width:thin}.pnq-roce-alert{margin-top:10px;color:#ffb5ba}' +
      '.pnq-roce-results-head{display:flex;align-items:center;gap:14px;margin:0 0 14px}.pnq-roce-results-head h3{margin:0 0 2px;font-size:16px;color:#f3f6fa}.pnq-roce-results-back{order:-1}.pnq-roce-evidence-expanded .pnq-roce-output{height:clamp(280px,46vh,520px);max-height:none;white-space:pre}.pnq-roce-evidence-expanded .pnq-roce-role{display:flex;min-height:0;flex-direction:column}.pnq-roce-evidence-expanded .pnq-roce-role dl{margin-bottom:10px}.pnq-roce-evidence-expanded .pnq-roce-output{flex:1;margin:0}' +
      '#pnq-roce-guides{padding:0}.pnq-roce-guide-layout{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:430px}' +
      '.pnq-roce-guide-nav{padding:14px;background:#121720;border-right:1px solid #303a49}.pnq-roce-guide-nav h3{margin:0 0 9px;font-size:12px;color:#aeb9c9;text-transform:uppercase;letter-spacing:.035em}' +
      '.pnq-roce-guide-choice{display:block;width:100%;margin:0 0 6px;padding:10px;text-align:left;border:1px solid transparent;border-radius:7px;background:transparent;color:#dce4ef;cursor:pointer}' +
      '.pnq-roce-guide-choice:hover{background:#1c2430}.pnq-roce-guide-choice[aria-current=true]{background:#202b39;border-color:#4a5b70;color:#fff}' +
      '.pnq-roce-guide-choice strong,.pnq-roce-guide-choice span{display:block}.pnq-roce-guide-choice span{margin-top:2px;color:#91a0b4;font-size:11px}' +
      '.pnq-roce-guide-detail{padding:20px 22px;max-width:76ch}.pnq-roce-guide-detail h3{margin:0 0 6px;font-size:17px;color:#f3f6fa}' +
      '.pnq-roce-guide-lead{margin:0 0 16px;color:#b9c5d5}.pnq-roce-guide-detail h4{margin:20px 0 7px;font-size:13px;color:#eef3f9}' +
      '.pnq-roce-guide-detail ol,.pnq-roce-guide-detail ul{margin:0;padding-left:20px}.pnq-roce-guide-detail li{margin:0;padding:7px 0;border-bottom:1px solid #293240}' +
      '.pnq-roce-guide-detail code{padding:2px 5px;border:1px solid #354052;border-radius:4px;background:#0c1118;color:#b9d8ff;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}' +
      '.pnq-roce-guide-note{margin-top:16px;padding:11px 12px;border:1px solid #4d5c70;border-radius:7px;background:#151d28;color:#c6d1df}' +
      '.pnq-roce-guide-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}' +
      '#pnq-roce-foot{padding:11px 18px;border-top:1px solid #303a49;background:#121720;' +
      'color:#9eabba;font-size:11px}' +
      '#pnq-roce-modal ::selection{background:#326cb7;color:#fff}' +
      '@media(max-width:760px){#pnq-roce-modal{padding:8px;align-items:stretch}#pnq-roce-dialog{max-height:none;width:100%}' +
      '#pnq-roce-minimized{right:12px;bottom:12px}' +
      '#pnq-roce-summary{gap:10px;flex-wrap:wrap}.pnq-roce-updated{width:100%;margin-left:0}' +
      '#pnq-roce-body{max-height:none;overflow:auto}#pnq-roce-body table{min-width:900px}' +
      '.pnq-roce-form,.pnq-roce-stages,.pnq-roce-evidence,.pnq-roce-guide-layout{grid-template-columns:1fr}' +
      '.pnq-roce-runstatus{align-items:flex-start;flex-wrap:wrap}.pnq-roce-results-open{margin-left:0}.pnq-roce-results-head{align-items:flex-start;flex-wrap:wrap}.pnq-roce-evidence-expanded .pnq-roce-output{height:38vh}' +
      '.pnq-roce-guide-nav{border-right:0;border-bottom:1px solid #303a49}.pnq-roce-guide-detail{padding:16px}}';
    document.head.appendChild(style);
  }

  function state(label, kind) {
    return '<span class="pnq-roce-state ' + kind + '"><span class="pnq-roce-dot" aria-hidden="true"></span>' + esc(label) + '</span>';
  }

  function firstInterface(h) {
    if (!h) return null;
    var inv = h.inventory || h;
    var health = h.health || h;
    var list = inv.interfaces;
    if (Array.isArray(list) && list.length) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === health.data_interface) return list[i];
      }
      return list[0];
    }
    if (h.interface && typeof h.interface === 'object') return h.interface;
    return null;
  }

  function rxeInfo(h) {
    if (!h) return null;
    var inv = h.inventory || h;
    if (inv.rdma && Array.isArray(inv.rdma.devices) && inv.rdma.devices.length) {
      var device = inv.rdma.devices[0];
      var port = Array.isArray(device.ports) && device.ports.length ? device.ports[0] : null;
      var gid = port && Array.isArray(port.gids) && port.gids.length ? port.gids[0] : null;
      return {
        device: device.name,
        ready: inv.rdma.rxe_ready === true,
        gid: gid && gid.value,
        netdev: device.netdev
      };
    }
    if (h.rxe && typeof h.rxe === 'object') return h.rxe;
    return h.rxe_device ? { device: h.rxe_device, ready: h.ready } : null;
  }

  function render() {
    if (!root) return;
    var body = root.querySelector('#pnq-roce-inventory');
    var summary = root.querySelector('#pnq-roce-summary');
    var healthy = nodes.filter(function (n) {
      return healthById[n.id] && healthById[n.id].reachable;
    }).length;
    var running = nodes.filter(function (n) {
      return n.status === 2 || (healthById[n.id] && healthById[n.id].reachable);
    }).length;
    summary.innerHTML =
      '<span><span class="pnq-roce-count">' + nodes.length + '</span> endpoints</span>' +
      '<span><span class="pnq-roce-count">' + running + '</span> powered on</span>' +
      '<span><span class="pnq-roce-count">' + healthy + '</span> agents reachable</span>' +
      '<span class="pnq-roce-updated">Health refreshes every 5 seconds</span>';

    if (!nodes.length) {
      body.innerHTML = '<div class="pnq-roce-empty"><i class="fa fa-server" aria-hidden="true"></i>' +
        '<strong>No RXE endpoints in this lab</strong><br>Add nodes using the RXE Endpoint template, then reopen this workspace.</div>';
      if (!run.resultsExpanded) renderRun();
      return;
    }
    var rows = nodes.map(function (n) {
      var result = healthById[n.id];
      var h = result && result.health;
      var healthDoc = h && (h.health || h);
      var iface = firstInterface(h);
      var rxe = rxeInfo(h);
      var power = (n.status === 2 || (result && result.reachable)) ? state('Running', 'ok') : state('Stopped', 'bad');
      var agent = !result ? state(n.status === 2 ? 'Checking' : 'Not running', n.status === 2 ? 'wait' : 'bad') :
        (result.reachable ? state('Healthy', 'ok') : state(result.error || 'Unreachable', 'bad'));
      var rxeLabel = rxe ? (rxe.device || rxe.name || 'RXE') : '—';
      var rxeReady = rxe && (rxe.ready === true || rxe.state === 'ready');
      var addresses = iface && iface.addresses;
      var ip = iface && (iface.ip || iface.address || iface.ipv4 ||
        (Array.isArray(addresses) && addresses.length ? addresses[0] : null));
      var mtu = iface && iface.mtu != null ? iface.mtu : '—';
      var jobs = healthDoc && healthDoc.active_jobs;
      if (Array.isArray(jobs)) jobs = jobs.length;
      if (jobs == null) jobs = '—';
      return '<tr>' +
        '<td><span class="pnq-roce-name">' + esc(n.name) + '</span><span class="pnq-roce-meta">Node ' + n.id + '</span></td>' +
        '<td>' + power + '</td>' +
        '<td>' + agent + (healthDoc && healthDoc.agent_version ? '<span class="pnq-roce-meta">v' + esc(healthDoc.agent_version) + '</span>' : '') + '</td>' +
        '<td>' + esc(healthDoc && healthDoc.kernel ? healthDoc.kernel : '—') + '</td>' +
        '<td>' + (rxe ? state(rxeLabel, rxeReady ? 'ok' : 'wait') : '<span class="pnq-roce-muted">—</span>') +
          (rxe && (rxe.gid || h.gid) ? '<span class="pnq-roce-meta">' + esc(rxe.gid || h.gid) + '</span>' : '') + '</td>' +
        '<td>' + esc(ip || '—') + (iface && iface.name ? '<span class="pnq-roce-meta">' + esc(iface.name) + '</span>' : '') + '</td>' +
        '<td>' + esc(mtu) + '</td><td>' + esc(jobs) + '</td></tr>';
    }).join('');
    body.innerHTML = '<table><colgroup><col style="width:18%"><col style="width:10%"><col style="width:15%">' +
      '<col style="width:15%"><col style="width:17%"><col style="width:12%"><col style="width:7%"><col style="width:6%"></colgroup>' +
      '<thead><tr><th>Endpoint</th><th>Power</th><th>Agent</th><th>Kernel</th><th>RXE / GID</th>' +
      '<th>Fabric IP</th><th>MTU</th><th>Jobs</th></tr></thead><tbody>' + rows + '</tbody></table>';
    if (!run.resultsExpanded) renderRun();
  }

  function eligibleNodes() {
    return nodes.filter(function (n) { return n.status === 2 && healthById[n.id] && healthById[n.id].reachable; });
  }

  function options(list, selected, other) {
    return '<option value="">Choose a running, reachable endpoint</option>' + list.map(function (n) {
      return '<option value="' + esc(n.id) + '"' + (String(n.id) === String(selected) ? ' selected' : '') +
        (String(n.id) === String(other) ? ' disabled' : '') + '>' + esc(n.name) + ' (node ' + esc(n.id) + ')</option>';
    }).join('');
  }

  function roleEvidence(label, side, expanded) {
    var role = side && side.result;
    if (!role) return '<section class="pnq-roce-role"><h3>' + label + '</h3><span class="pnq-roce-muted">No role evidence yet.</span></section>';
    var clean = role.cleanup || {}, output = String(role.output || '');
    if (!expanded) output = output.slice(0, 4096);
    function yesNo(value) { return value === true ? 'yes' : value === false ? 'no' : '—'; }
    return '<section class="pnq-roce-role"><h3>' + label + '</h3><dl>' +
      '<dt>State</dt><dd>' + esc(role.state || '—') + '</dd><dt>Exit</dt><dd>' + esc(role.exit_code == null ? '—' : role.exit_code) + '</dd>' +
      '<dt>Forced</dt><dd>' + yesNo(role.forced) + '</dd><dt>Truncated</dt><dd>' + yesNo(role.truncated) + '</dd>' +
      '<dt>Cleanup complete</dt><dd>' + yesNo(clean.complete) + '</dd><dt>Processes remaining</dt><dd>' + yesNo(clean.processes_remaining) + '</dd>' +
      '<dt>RDMA unchanged</dt><dd>' + yesNo(clean.rdma_unchanged) + '</dd><dt>qdisc unchanged</dt><dd>' + yesNo(clean.qdisc_unchanged) + '</dd></dl>' +
      (role.error ? '<p class="pnq-roce-alert" role="alert">' + esc(role.error) + '</p>' : '') +
      '<pre class="pnq-roce-output" tabindex="0" aria-label="' + label + ' bounded output">' + esc(output || 'No output.') + '</pre></section>';
  }

  function runFocusKey(panel) {
    var active = document.activeElement;
    if (!active || !panel.contains(active)) return '';
    if (active.id === 'pnq-roce-server' || active.id === 'pnq-roce-client') return '#' + active.id;
    if (active.classList.contains('pnq-roce-start')) return '.pnq-roce-start';
    if (active.classList.contains('pnq-roce-cancel')) return '.pnq-roce-cancel';
    if (active.classList.contains('pnq-roce-results-open')) return '.pnq-roce-results-open';
    if (active.classList.contains('pnq-roce-results-back')) return '.pnq-roce-results-back';
    if (active.classList.contains('pnq-roce-output')) {
      return /^Server role/.test(active.getAttribute('aria-label') || '') ?
        '.pnq-roce-role:first-child .pnq-roce-output' : '.pnq-roce-role:last-child .pnq-roce-output';
    }
    return '';
  }

  function restoreRunFocus(panel, key, busy) {
    if (!key) return;
    var target = panel.querySelector(key);
    if (!target || target.disabled || target.offsetParent === null) {
      target = panel.querySelector(busy ? '.pnq-roce-cancel:not([disabled])' : '.pnq-roce-start:not([disabled])');
    }
    if (!target) target = root.querySelector('.pnq-roce-iconbtn');
    if (target) target.focus();
  }

  function guideBody(id) {
    if (id === 'routing') return '<h3>Addressing and routing mistakes</h3>' +
      '<p class="pnq-roce-guide-lead">Prove the IP path before asking RDMA tools to explain it.</p>' +
      '<h4>Work from the endpoint outward</h4><ol>' +
      '<li>Use <code>ip show</code> at each RXE console. Confirm the intended address, prefix and optional default gateway.</li>' +
      '<li>For a direct subnet, both peers need compatible prefixes. For a routed path, confirm each endpoint gateway and the fabric return route.</li>' +
      '<li>Ping the peer fabric address. A failure here is an IP problem; do not interpret it as an RDMA result.</li>' +
      '<li>Compare endpoint and fabric MTU. A small ping can pass while larger traffic exposes an MTU mismatch.</li>' +
      '<li>After IP succeeds, check RXE/GID readiness in Inventory and use Run Pair for the bounded RDMA sequence.</li></ol>' +
      '<div class="pnq-roce-guide-note">Console shortcuts: <code>ip ADDRESS/PREFIX [GATEWAY]</code> applies a profile and <code>ip clear</code> removes it. The modal never sends shell text or credentials.</div>';
    if (id === 'lifecycle') return '<h3>Completion, cancellation and cleanup</h3>' +
      '<p class="pnq-roce-guide-lead">A workload outcome is trustworthy only when its role result and cleanup evidence agree.</p>' +
      '<h4>Read the stage rail</h4><ol>' +
      '<li><strong>Preparing:</strong> the broker owns a bounded run and both endpoint reservations.</li>' +
      '<li><strong>Waiting for server:</strong> listener readiness must be observed before the client starts.</li>' +
      '<li><strong>Running:</strong> both roles must terminate with validated output. Forced termination cannot become a normal pass.</li>' +
      '<li><strong>Cancelled or timed out:</strong> remain non-PASS even when cleanup succeeds.</li>' +
      '<li><strong>Cleanup failed:</strong> inspect processes, RDMA and qdisc evidence. The modal blocks another run until the endpoints are reconciled.</li></ol>' +
      '<div class="pnq-roce-guide-note">Minimizing keeps the controller and its polling active; it does not cancel the run. Reset pair explicitly cancels owned workloads and releases only clean reservations. The bounded guest lease still protects browser disconnects.</div>';
    if (id === 'capture') return '<h3>Read RoCEv2 packets</h3>' +
      '<p class="pnq-roce-guide-lead">Use packet evidence to confirm where RoCEv2 is visible, not to infer hardware behavior.</p>' +
      '<h4>Capture workflow</h4><ol>' +
      '<li>Start PNETLab link capture on the endpoint\'s guest-fabric attachment, outside this modal.</li>' +
      '<li>Open Run Pair and run the bounded sequence, then stop the capture promptly.</li>' +
      '<li>Open the PCAP in Wireshark and apply <code>udp.port == 4791</code>.</li>' +
      '<li>If packets are missing, compare capture points on both sides of the path. Placement, encapsulation and guest/host offload can change visibility.</li>' +
      '<li>Correlate the packet timestamps with the modal stage and role result; a visible UDP/4791 flow alone is not a strict pair PASS.</li></ol>' +
      '<div class="pnq-roce-guide-note">This controller does not start or download captures yet. Use the existing PNETLab capture surface and keep the PCAP bounded.</div>';
    return '<h3>IP reachability vs RDMA readiness</h3>' +
      '<p class="pnq-roce-guide-lead">A successful ping proves an IP path. It does not prove RXE, a usable GID, RDMA-CM listener readiness or verbs completion.</p>' +
      '<h4>Three evidence layers</h4><ol>' +
      '<li><strong>Endpoint:</strong> Inventory shows both nodes powered on, their agents reachable, fabric addresses and MTU.</li>' +
      '<li><strong>IP:</strong> ping the peer fabric address from the RXE console. Fix addressing or routing before continuing.</li>' +
      '<li><strong>RDMA:</strong> require ready <code>rxe0</code> and a GID, then run the pair. Only terminal <code>pair_pass</code> with clean role evidence passes this software-RDMA check.</li></ol>' +
      '<h4>Interpret the split</h4><ul>' +
      '<li>Ping fails: inspect address, prefix, gateway, fabric route and MTU.</li>' +
      '<li>Ping passes but RXE/GID is not ready: inspect endpoint RDMA setup.</li>' +
      '<li>Ping and inventory pass but rping fails: inspect listener readiness, RDMA-CM and both role results.</li></ul>';
  }

  function renderGuides() {
    if (!root) return;
    var panel = root.querySelector('#pnq-roce-guides'); if (!panel) return;
    var choices = GUIDES.map(function (guide) {
      return '<button type="button" class="pnq-roce-guide-choice" data-guide="' + guide.id + '" aria-current="' +
        (guide.id === activeGuide ? 'true' : 'false') + '"><strong>' + esc(guide.title) + '</strong><span>' + esc(guide.summary) + '</span></button>';
    }).join('');
    panel.innerHTML = '<div class="pnq-roce-guide-layout"><nav class="pnq-roce-guide-nav" aria-label="Guided exercises"><h3>Choose an exercise</h3>' + choices +
      '</nav><article class="pnq-roce-guide-detail" aria-live="polite">' + guideBody(activeGuide) +
      '<div class="pnq-roce-guide-actions"><button type="button" class="pnq-roce-button" data-destination="inventory">Open Inventory</button>' +
      '<button type="button" class="pnq-roce-button primary" data-destination="run">Open Run Pair</button></div></article></div>';
    panel.querySelectorAll('.pnq-roce-guide-choice').forEach(function (button) {
      button.addEventListener('click', function () { activeGuide = button.getAttribute('data-guide'); renderGuides();
        var selected = panel.querySelector('[data-guide="' + activeGuide + '"]'); if (selected) selected.focus(); });
    });
    panel.querySelectorAll('[data-destination]').forEach(function (button) {
      button.addEventListener('click', function () { var destination = button.getAttribute('data-destination'); selectTab(destination);
        var tab = root.querySelector('[data-tab="' + destination + '"]'); if (tab) tab.focus(); });
    });
  }

  function renderRun() {
    if (!root) return;
    var panel = root.querySelector('#pnq-roce-run'); if (!panel) return;
    var focusKey = runFocusKey(panel);
    var list = eligibleNodes(), busy = run.active || run.cancelling;
    var pairSelected = run.serverId && run.clientId && String(run.serverId) !== String(run.clientId);
    var canRun = list.length >= 2 && !busy && !run.blocked && pairSelected;
    var stages = run.stages.map(function (stage, i) {
      var kind = stage.state === 'passed' ? 'ok' : /^(failed|cancelled|cleanup_failed)$/.test(stage.state) ? 'bad' : (i === run.toolIndex && busy ? 'wait' : '');
      return '<li class="' + kind + '"><strong>' + (i + 1) + '. ' + esc(stage.tool) + '</strong><span class="pnq-roce-meta">' + esc(stage.state) + '</span></li>';
    }).join('');
    var shortId = run.runId ? run.runId.slice(0, 8) + '…' + run.runId.slice(-4) : '—';
    if (run.resultsExpanded && run.evidence) {
      var toolName = run.toolIndex >= 0 && run.stages[run.toolIndex] ? run.stages[run.toolIndex].tool : 'workload';
      panel.innerHTML = '<div class="pnq-roce-results-head"><button type="button" class="pnq-roce-button pnq-roce-results-back"><i class="fa fa-arrow-left" aria-hidden="true"></i> Back to run</button>' +
        '<div><h3>Latest workload results</h3><span class="pnq-roce-meta">' + esc(toolName) + ' · Run ID: ' + esc(shortId) + '</span></div></div>' +
        '<div class="pnq-roce-evidence pnq-roce-evidence-expanded">' + roleEvidence('Server role', run.evidence.server, true) + roleEvidence('Client role', run.evidence.client, true) + '</div>';
      panel.querySelector('.pnq-roce-results-back').addEventListener('click', function () {
        run.resultsExpanded = false; renderRun();
        var openButton = panel.querySelector('.pnq-roce-results-open'); if (openButton) openButton.focus();
      });
      restoreRunFocus(panel, focusKey, busy);
      return;
    }
    var hasResults = !!(run.evidence && ((run.evidence.server && run.evidence.server.result) ||
      (run.evidence.client && run.evidence.client.result)));
    panel.innerHTML = '<div class="pnq-roce-form"><div class="pnq-roce-field"><label for="pnq-roce-server">Server endpoint</label><select id="pnq-roce-server"' + (busy ? ' disabled' : '') + '>' + options(list, run.serverId, run.clientId) + '</select></div>' +
      '<div class="pnq-roce-field"><label for="pnq-roce-client">Client endpoint</label><select id="pnq-roce-client"' + (busy ? ' disabled' : '') + '>' + options(list, run.clientId, run.serverId) + '</select></div>' +
      '<button type="button" class="pnq-roce-button primary pnq-roce-start"' + (canRun ? '' : ' disabled') + '>Run sequence</button>' +
      '<button type="button" class="pnq-roce-button danger pnq-roce-cancel"' + (busy && !run.cancelSent ? '' : ' disabled') + '>Cancel run</button>' +
      '<button type="button" class="pnq-roce-button recover pnq-roce-reset"' + (!busy && pairSelected ? '' : ' disabled') +
      ' title="Cancel owned workloads and release only clean reservations">Reset pair</button></div>' +
      '<div class="pnq-roce-runstatus" aria-live="polite"><div class="pnq-roce-runstatus-main"><strong>Current phase:</strong> ' + esc(run.phase) + '<span class="pnq-roce-meta">Run ID: ' + esc(shortId) + '</span></div>' +
      (hasResults ? '<button type="button" class="pnq-roce-button pnq-roce-results-open"><i class="fa fa-expand" aria-hidden="true"></i> View full results</button>' : '') + '</div>' +
      '<ol class="pnq-roce-stages" aria-label="Ordered workload stages">' + stages + '</ol>' +
      (run.notice ? '<p class="pnq-roce-guide-note" role="status">' + esc(run.notice) + '</p>' : '') +
      (run.error ? '<p class="pnq-roce-alert" role="alert">' + esc(run.error) + '</p>' : '') +
      (run.blocked ? '<p class="pnq-roce-alert" role="alert">Cleanup failed. Reset the pair after correcting the endpoint problem; dirty reservations stay protected.</p>' : '') +
      '<div class="pnq-roce-evidence">' + roleEvidence('Server role', run.evidence && run.evidence.server) + roleEvidence('Client role', run.evidence && run.evidence.client) + '</div>';
    panel.querySelector('#pnq-roce-server').addEventListener('change', function (e) { run.serverId = e.target.value; renderRun(); });
    panel.querySelector('#pnq-roce-client').addEventListener('change', function (e) { run.clientId = e.target.value; renderRun(); });
    panel.querySelector('.pnq-roce-start').addEventListener('click', startSequence);
    panel.querySelector('.pnq-roce-cancel').addEventListener('click', cancelSequence);
    panel.querySelector('.pnq-roce-reset').addEventListener('click', resetPair);
    var resultsButton = panel.querySelector('.pnq-roce-results-open');
    if (resultsButton) resultsButton.addEventListener('click', function () {
      run.resultsExpanded = true; renderRun();
      var backButton = panel.querySelector('.pnq-roce-results-back'); if (backButton) backButton.focus();
    });
    restoreRunFocus(panel, focusKey, busy);
    updateMinimizedControl();
  }

  function showError(message) {
    if (!root) return;
    root.querySelector('#pnq-roce-inventory').innerHTML = '<div class="pnq-roce-error" role="alert">' + esc(message) +
      '<button type="button" class="pnq-roce-retry">Try again</button></div>';
    root.querySelector('.pnq-roce-retry').addEventListener('click', loadInventory);
  }

  function request(url, options) {
    return fetch(url, options).then(function (response) {
      return response.json().catch(function () { throw new Error('The controller returned invalid data.'); })
        .then(function (data) {
          if (!response.ok) throw new Error(data.error || 'The controller request failed.');
          return data;
        });
    });
  }

  function typed(action, fields) {
    var body = { action: action };
    Object.keys(fields || {}).forEach(function (key) { body[key] = fields[key]; });
    return request(API, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  async function resetPair() {
    if (run.active || run.cancelling || !run.serverId || !run.clientId || String(run.serverId) === String(run.clientId)) return;
    if (!window.confirm('Reset this RXE pair? This cancels owned workloads and releases only reservations with clean terminal evidence. The nodes are not rebooted.')) return;
    var token = generation, seq = ++sequenceToken, server = Number(run.serverId), client = Number(run.clientId);
    run.phase = 'resetting'; run.error = ''; run.notice = ''; renderRun();
    try {
      var doc = await typed('reset-pair', { server_id: server, client_id: client });
      if (!current(token, seq)) return;
      run = newRun(); run.serverId = server; run.clientId = client;
      run.phase = doc.state === 'reset' ? 'ready' : 'attention';
      run.blocked = doc.state !== 'reset';
      run.notice = doc.state === 'reset' ?
        (doc.reset_count ? 'Pair reset. ' + doc.reset_count + ' owned workload(s) cancelled and reconciled.' : 'Pair is ready. No active owned workloads were found.') :
        '';
      run.error = doc.state === 'reset' ? '' :
        (doc.error || 'Reset needs attention. One or more reservations could not be released safely.');
      renderRun();
    } catch (err) {
      if (!current(token, seq)) return;
      run.phase = 'reset-error'; run.blocked = true; run.error = err.message; renderRun();
    }
  }

  function current(token, seq) { return !!root && token === generation && seq === sequenceToken; }
  function pause(token, seq) { return new Promise(function (resolve) {
    window.setTimeout(function () { resolve(current(token, seq)); }, 750);
  }); }
  function clearWorkloadTimer() { window.clearTimeout(workloadTimer); workloadTimer = 0; }

  async function pollWorkload(action, token, seq, readiness) {
    while (current(token, seq)) {
      var doc = await typed(action, { run_id: run.runId });
      if (!current(token, seq)) return null;
      run.evidence = doc;
      run.phase = readiness ? 'waiting-for-server' :
        (doc.terminal === true ? 'cleaning-up' : (run.cancelling ? 'cancelling' : 'running'));
      renderRun();
      if (doc.state === 'cleanup_failed') return doc;
      if (readiness && doc.server && doc.server.result && doc.server.result.state === 'ready') return doc;
      if (readiness && doc.terminal === true) return doc;
      if (!readiness && doc.terminal === true) return doc;
      if (!(await pause(token, seq))) return null;
    }
    return null;
  }

  function latch(doc, fallback, forceFallback) {
    doc = doc || {};
    run.evidence = doc; run.active = false; run.cancelling = false;
    clearWorkloadTimer();
    var outcome = forceFallback ? (fallback || 'failed') : (doc.state || fallback || 'failed');
    sequenceToken++;
    run.phase = outcome;
    if (run.toolIndex >= 0) run.stages[run.toolIndex].state = outcome;
    if (outcome === 'cleanup_failed') run.blocked = true;
    if (outcome !== 'passed') run.error = outcome === 'cancelled' ?
      'Run cancelled. Terminal cleanup evidence is shown below.' : (doc.error || 'The sequence stopped at ' + outcome + '.');
    renderRun();
  }

  function reconciledCancellation(resultDoc, observedDoc) {
    resultDoc = resultDoc || {}; observedDoc = observedDoc || {};
    var states = [observedDoc.state, resultDoc.state];
    var outcome = states.indexOf('cleanup_failed') >= 0 ? 'cleanup_failed' :
      (states.indexOf('cancelled') >= 0 ? 'cancelled' :
        (resultDoc.state && resultDoc.state !== 'passed' ? resultDoc.state :
          (observedDoc.state && observedDoc.state !== 'passed' ? observedDoc.state : 'cancelled')));
    resultDoc.state = outcome;
    if (outcome !== 'passed') resultDoc.pair_pass = false;
    var observedTerminal = observedDoc.state === 'cleanup_failed' || observedDoc.state === 'cancelled';
    if (observedDoc.server && (observedTerminal || !resultDoc.server)) resultDoc.server = observedDoc.server;
    if (observedDoc.client && (observedTerminal || !resultDoc.client)) resultDoc.client = observedDoc.client;
    return resultDoc;
  }

  async function startSequence() {
    if (run.active || run.blocked || !run.serverId || !run.clientId || String(run.serverId) === String(run.clientId)) return;
    var token = generation, seq = ++sequenceToken, server = Number(run.serverId), client = Number(run.clientId);
    run = newRun(); run.active = true; run.serverId = server; run.clientId = client; renderRun();
    try {
      for (var i = 0; i < TOOLS.length; i++) {
        if (!current(token, seq)) return;
        run.toolIndex = i; run.runId = ''; run.cancelPending = false; run.cancelSent = false; run.cancelling = false;
        run.phase = 'preparing'; run.stages[i].state = 'preparing'; renderRun();
        var doc = await typed('prepare', { server_id: server, client_id: client, tool: TOOLS[i], lease_seconds: 120 });
        if (!current(token, seq)) return;
        run.runId = doc.run_id; run.evidence = doc;
        if (!/^[0-9a-f]{32}$/.test(run.runId || '')) throw new Error('The controller did not return a valid run ID.');
        if (run.cancelPending) {
          run.cancelPending = false; run.cancelSent = false;
          await cancelSequence('Run cancelled during endpoint preparation.'); return;
        }
        clearWorkloadTimer();
        workloadTimer = window.setTimeout(function () {
          if (current(token, seq)) cancelSequence('The workload exceeded its 120 second bound.');
        }, 120000);
        run.phase = 'starting-server'; renderRun();
        await typed('start-server', { run_id: run.runId }); if (!current(token, seq)) return;
        doc = await pollWorkload('readiness', token, seq, true); if (!doc || !current(token, seq)) return;
        if (doc.state === 'cleanup_failed') { latch(doc); return; }
        if (doc.terminal === true) { latch(doc, doc.state || 'failed'); return; }
        run.phase = 'starting-client'; renderRun();
        await typed('start-client', { run_id: run.runId }); if (!current(token, seq)) return;
        doc = await pollWorkload('status', token, seq, false); if (!doc || !current(token, seq)) return;
        if (doc.state === 'cleanup_failed') { latch(doc); return; }
        run.phase = 'result'; renderRun();
        doc = await typed('result', { run_id: run.runId }); if (!current(token, seq)) return;
        run.evidence = doc; clearWorkloadTimer();
        if (doc.state === 'cleanup_failed') { latch(doc); return; }
        if (!(doc.terminal === true && doc.state === 'passed' && doc.pair_pass === true)) {
          if (doc.state === 'cancelled' || doc.state === 'failed') latch(doc);
          else latch(doc, 'failed', true);
          return;
        }
        run.stages[i].state = 'passed'; run.phase = i === TOOLS.length - 1 ? 'passed' : 'advancing'; renderRun();
      }
      run.active = false; clearWorkloadTimer(); renderRun();
    } catch (err) {
      if (!current(token, seq)) return;
      run.error = err.message;
      if (run.runId) cancelSequence(err.message); else latch(null, run.cancelPending ? 'cancelled' : 'failed');
    }
  }

  async function cancelSequence(reason) {
    if (!run.active || run.cancelSent) return;
    if (!run.runId) {
      run.cancelPending = true; run.cancelSent = true; run.cancelling = true;
      run.phase = 'cancel-requested';
      run.error = typeof reason === 'string' ? reason : 'Cancelling after endpoint preparation completes.';
      renderRun(); return;
    }
    var token = generation, seq = ++sequenceToken;
    run.cancelSent = true; run.cancelling = true; run.phase = 'cancel-requested';
    if (typeof reason === 'string') run.error = reason;
    renderRun();
    try {
      var doc = await typed('cancel', { run_id: run.runId }); if (!current(token, seq)) return;
      run.evidence = doc; renderRun();
      if (doc.state !== 'cleanup_failed' && doc.terminal !== true) doc = await pollWorkload('status', token, seq, false);
      if (!doc || !current(token, seq)) return;
      if (doc.state === 'cleanup_failed') { latch(doc); return; }
      run.phase = 'result'; renderRun();
      var finalDoc = await typed('result', { run_id: run.runId }); if (!current(token, seq)) return;
      finalDoc = reconciledCancellation(finalDoc, doc);
      latch(finalDoc, finalDoc.state, true);
    } catch (err) {
      if (!current(token, seq)) return;
      run.error = err.message + ' Waiting for lease cleanup status.'; renderRun();
      try {
        var observed = await pollWorkload('status', token, seq, false);
        if (!observed || !current(token, seq)) return;
        if (observed.state === 'cleanup_failed') { latch(observed); return; }
        run.phase = 'result'; renderRun();
        var recovered = await typed('result', { run_id: run.runId }); if (!current(token, seq)) return;
        recovered = reconciledCancellation(recovered, observed);
        latch(recovered, recovered.state, true);
      } catch (statusErr) {
        if (current(token, seq)) {
          run.error = statusErr.message; run.phase = 'cancel-error';
          run.cancelling = false; run.cancelSent = false; renderRun();
        }
      }
    }
  }

  function pollHealth() {
    if (!root || polling) return;
    var token = generation;
    var ids = nodes.filter(function (n) { return n.status === 2; })
      .map(function (n) { return n.id; });
    if (!ids.length) return;
    polling = true;
    var probes = ids.map(function (id) {
      return request(API, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'health', node_ids: [id] })
      }).then(function (data) {
        return data.health && data.health[0] ? data.health[0] :
          { id: id, reachable: false, health: null, error: 'Missing health result' };
      }).catch(function (err) {
        return { id: id, reachable: false, health: null, error: err.message };
      });
    });
    Promise.all(probes).then(function (results) {
      if (!root || token !== generation) return;
      results.forEach(function (h) { healthById[h.id] = h; });
      render();
    }).then(function () {
      if (token === generation) polling = false;
    });
  }

  function loadInventory() {
    var token = generation;
    healthById = {};
    polling = true;
    if (root) render();
    request(API, { credentials: 'same-origin' }).then(function (data) {
      if (!root || token !== generation) return;
      nodes = Array.isArray(data.nodes) ? data.nodes : [];
      LIMIT = data.validity_limit || LIMIT;
      if (root) root.querySelector('#pnq-roce-foot').textContent = LIMIT;
      render();
      polling = false;
      pollHealth();
    }).catch(function (err) {
      if (root && token === generation) {
        polling = false;
        showError(err.message);
      }
    });
  }

  function updateMinimizedControl() {
    if (!minimizedControl) return;
    var label = run.phase === 'idle' ? 'minimized' : run.phase;
    minimizedControl.innerHTML = '<i class="fa fa-exchange" aria-hidden="true"></i><span>RoCE Lab</span>' +
      '<span class="pnq-roce-mini-state">' + esc(label) + '</span>';
    minimizedControl.setAttribute('aria-label', 'Restore RoCE Lab, ' + label);
  }

  function restore() {
    if (!root) return;
    root.hidden = false;
    if (minimizedControl && minimizedControl.parentNode) minimizedControl.parentNode.removeChild(minimizedControl);
    minimizedControl = null;
    var target = root.querySelector(run.active || run.cancelling ? '.pnq-roce-cancel:not([disabled])' : '.pnq-roce-minimize');
    if (target) target.focus();
  }

  function minimize() {
    if (!root || root.hidden) return;
    root.hidden = true;
    if (!minimizedControl) {
      minimizedControl = document.createElement('button');
      minimizedControl.id = 'pnq-roce-minimized'; minimizedControl.type = 'button';
      minimizedControl.addEventListener('click', restore);
      document.body.appendChild(minimizedControl);
    }
    updateMinimizedControl();
    minimizedControl.focus();
  }

  function close() {
    generation++; sequenceToken++; clearWorkloadTimer();
    window.clearInterval(pollTimer); window.clearInterval(inventoryTimer);
    pollTimer = inventoryTimer = 0;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    if (minimizedControl && minimizedControl.parentNode) minimizedControl.parentNode.removeChild(minimizedControl);
    minimizedControl = null;
    root = null; polling = false; nodes = []; healthById = {}; run = newRun();
    if (opener && document.contains(opener)) opener.focus();
  }

  function onKeydown(event) {
    if (!root) return;
    if (event.key === 'Escape') { event.preventDefault(); minimize(); return; }
    if (event.key !== 'Tab') return;
    var focusable = Array.prototype.slice.call(root.querySelectorAll(
      'button:not([disabled]):not([tabindex="-1"]),a[href],input:not([disabled]),select:not([disabled]),pre[tabindex]'
    )).filter(function (element) { return element.offsetParent !== null; });
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function selectTab(name) {
    activeTab = name;
    root.querySelectorAll('.pnq-roce-tab').forEach(function (button) {
      var selected = button.getAttribute('data-tab') === name;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    });
    root.querySelector('#pnq-roce-inventory').hidden = name !== 'inventory';
    root.querySelector('#pnq-roce-run').hidden = name !== 'run';
    root.querySelector('#pnq-roce-guides').hidden = name !== 'guides';
    if (name === 'run') renderRun();
    if (name === 'guides') renderGuides();
  }

  function onTabKeydown(event) {
    if (!/^(ArrowLeft|ArrowRight|Home|End)$/.test(event.key)) return;
    var tabs = Array.prototype.slice.call(root.querySelectorAll('.pnq-roce-tab'));
    var currentIndex = tabs.indexOf(event.currentTarget), nextIndex = currentIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else nextIndex = (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    selectTab(tabs[nextIndex].getAttribute('data-tab'));
    tabs[nextIndex].focus();
  }

  function open(event) {
    if (event) { event.preventDefault(); opener = event.currentTarget; }
    if (root) { restore(); return; }
    generation++; sequenceToken++;
    nodes = []; healthById = {}; polling = false; run = newRun(); activeTab = 'inventory'; activeGuide = 'readiness';
    injectCss();
    root = document.createElement('div'); root.id = 'pnq-roce-modal';
    root.innerHTML = '<section id="pnq-roce-dialog" role="dialog" aria-modal="true" aria-labelledby="pnq-roce-title">' +
      '<header id="pnq-roce-head"><i class="fa fa-exchange" aria-hidden="true"></i><div>' +
      '<h2 id="pnq-roce-title">RoCE Lab</h2><div class="pnq-roce-sub">RXE readiness, pair lifecycle and guided troubleshooting</div></div>' +
      '<span class="pnq-roce-spacer"></span><button type="button" class="pnq-roce-iconbtn pnq-roce-minimize" aria-label="Minimize RoCE Lab">' +
      '<i class="fa fa-minus" aria-hidden="true"></i></button></header>' +
      '<div class="pnq-roce-tabs" role="tablist" aria-label="RoCE Lab views">' +
      '<button id="pnq-roce-tab-inventory" type="button" class="pnq-roce-tab" role="tab" data-tab="inventory" aria-controls="pnq-roce-inventory" aria-selected="true">Inventory</button>' +
      '<button id="pnq-roce-tab-run" type="button" class="pnq-roce-tab" role="tab" data-tab="run" aria-controls="pnq-roce-run" aria-selected="false" tabindex="-1">Run Pair</button>' +
      '<button id="pnq-roce-tab-guides" type="button" class="pnq-roce-tab" role="tab" data-tab="guides" aria-controls="pnq-roce-guides" aria-selected="false" tabindex="-1">Guides</button></div>' +
      '<div id="pnq-roce-summary" aria-live="polite"><span class="pnq-roce-muted">Loading endpoint inventory…</span></div>' +
      '<div id="pnq-roce-body"><div id="pnq-roce-inventory" class="pnq-roce-panel" role="tabpanel" aria-labelledby="pnq-roce-tab-inventory"><div class="pnq-roce-empty"><i class="fa fa-circle-o-notch fa-spin" aria-hidden="true"></i>Loading…</div></div>' +
      '<div id="pnq-roce-run" class="pnq-roce-panel" role="tabpanel" aria-labelledby="pnq-roce-tab-run" hidden></div>' +
      '<div id="pnq-roce-guides" class="pnq-roce-panel" role="tabpanel" aria-labelledby="pnq-roce-tab-guides" hidden></div></div>' +
      '<footer id="pnq-roce-foot">' + esc(LIMIT) + '</footer></section>';
    document.body.appendChild(root);
    root.querySelector('.pnq-roce-minimize').addEventListener('click', minimize);
    root.querySelectorAll('.pnq-roce-tab').forEach(function (button) {
      button.addEventListener('click', function () { selectTab(button.getAttribute('data-tab')); });
      button.addEventListener('keydown', onTabKeydown);
    });
    root.addEventListener('click', function (e) { if (e.target === root) minimize(); });
    root.addEventListener('keydown', onKeydown);
    root.querySelector('.pnq-roce-iconbtn').focus();
    renderGuides();
    loadInventory();
    pollTimer = window.setInterval(pollHealth, 5000);
    inventoryTimer = window.setInterval(loadInventory, 15000);
  }

  function inject() {
    if (document.getElementById('pnq-roce-lab')) return true;
    var ul = document.querySelector('#lab-sidebar ul');
    if (!ul) return false;
    var li = document.createElement('li'); li.id = 'pnq-roce-lab';
    li.innerHTML = '<a href="javascript:void(0)" title="Inspect RXE endpoint and agent health">' +
      '<i class="fa fa-exchange" style="font-size:15px" aria-hidden="true"></i>' +
      '<span class="lab-sidebar-title">RoCE Lab</span></a>';
    li.querySelector('a').addEventListener('click', open);
    var anchor = document.getElementById('pnq-wifipainter');
    if (anchor && anchor.parentNode === ul) ul.insertBefore(li, anchor.nextSibling);
    else ul.appendChild(li);
    return true;
  }

  function init() {
    if (inject()) return;
    var observer = new MutationObserver(function () { if (inject()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
