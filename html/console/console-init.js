/* console-init.js — externalized from console.html (CSP forbids inline
   scripts). Still an ES module; relative imports resolve as before. */
  import { ConsoleTabs } from './console-tabs.js?v=b8f31ddb';
  // noVNC RFB is an ES module (default export). Vendored locally; expose it as
  // the global console-tabs.js::_mountVnc looks for. The static import resolves
  // its whole dependency graph (core/* + vendor/pako/*) before this body runs,
  // so window.RFB is ready well before any VNC tab is lazily mounted.
  import RFB from './vendor/novnc/core/rfb.js';
  window.RFB = RFB;

  // tokenUrl defaults to the relative 'token_mint.php' (same dir as this page),
  // so the console works regardless of where the web root is mounted.
  const tabs = new ConsoleTabs(document.getElementById('console'));
  const list = document.getElementById('node-list');
  const refreshEl = document.getElementById('nodes-refresh');

  // Collapsible node sidebar: arrow collapses the list to a thin rail (the
  // console fills the width); the rail hover-peeks the list (CSS) without reflow;
  // clicking the arrow re-pins. State persists across opens.
  const COLLAPSE_KEY = 'pnq_wc_nodes_collapsed';
  const nodesEl  = document.getElementById('nodes');
  const toggleEl = document.getElementById('nodes-toggle');
  function applyCollapsed(c) {
    nodesEl.classList.toggle('collapsed', c);
    toggleEl.innerHTML = c ? '&#xBB;' : '&#xAB;';            // » expand : « collapse
    toggleEl.title = c ? 'Pin sidebar open' : 'Collapse sidebar';
  }
  let collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
  applyCollapsed(collapsed);
  toggleEl.addEventListener('click', (e) => {
    e.stopPropagation();
    collapsed = !collapsed;
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    applyCollapsed(collapsed);
  });

  // Packet-capture deep-link: console.html?capture=1&node=&iface=&name= opens an
  // RDP tab straight to the Wireshark container (token_mint capture mode looks it
  // up in the wiresharks table — no lab-node list needed). Skip the topology load.
  const capQ = new URLSearchParams(location.search);
  const isCapture = capQ.get('capture') === '1' && !!capQ.get('node');
  // Inside the Captures aggregator the shell owns the tab strip — hide our own.
  if (isCapture) document.documentElement.classList.add('pnq-capture-embed');
  // Host-shell deep-link: console.html?shell=1 opens one admin host-shell tab
  // (token_mint type=shell -> shell_ws_bridge.py login). No topology list needed.
  const isShell = capQ.get('shell') === '1';
  // Single-node / pop-out launch (console.html?node=ID): this window is dedicated
  // to ONE node (an individual node-console click or a detached/popped-out tab),
  // so hide the node list entirely. Only the quick-bar "all nodes" window (no
  // ?node) keeps the list visible. Capture/shell already hide it below.
  const isSingleNode = !isCapture && !isShell && !!capQ.get('node');
  if (isSingleNode) nodesEl.style.display = 'none';
  if (refreshEl) refreshEl.hidden = isCapture || isShell || isSingleNode;
  // Pop-out (tab → own window) only applies in the combined main window.
  tabs.allowPopout = !isSingleNode && !isCapture && !isShell;
  // Report the open tab set up to the window manager so it can persist + restore
  // the combined window's exact tabs across a page refresh.
  tabs.onTabsChange = (ids) => {
    try {
      if (window.parent && window.parent !== window)
        window.parent.postMessage({ pnq: 'tabs', nodes: ids }, location.origin);
    } catch (e) {}
  };
  // Pop-out (⇱ per-tab button) is removed; detach is now via the sidebar ↗ button
  // which calls tabs.close() + detach() directly. onPopOut is a no-op stub kept
  // for any external callers that may set it.
  tabs.onPopOut = () => {};
  // The window manager asks this (main) window to open a node as a tab — used by
  // "pop in" to dock a per-node window back into the combined window.
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.pnq !== 'opentab' || d.node == null) return;
    const id = String(d.node);                          // tab key (may be composite, e.g. "12::2")
    const name = d.name || `Node ${d.node}`;
    const type = d.type || 'telnet';
    // 2nd-console tabs carry the REAL node id + a second flag so the mint targets
    // console_2nd / the second port (see console-tabs._mint).
    tabs.openNode({ id, nodeId: d.nodeId != null ? String(d.nodeId) : id, name, type, second: !!d.second, isDocker: !!d.isDocker });
    // Ensure a sidebar entry exists — it may be absent if this combined window
    // was freshly created by the pop-in, or if the node was added after initial load.
    if (list && !list.querySelector(`[data-nid="${CSS.escape(id)}"]`)) {
      addButton({ id, name, console: (type === 'telnet' || type === 'bash') ? '' : type, image: '' });
    }
  });
  if (isShell) {
    list.textContent = 'Host shell session.';
    tabs.openNode({ id: 'shell', name: 'Host Shell', type: 'shell' });
    try {
      if (window.parent && window.parent !== window)
        window.parent.postMessage({ pnq: 'title', node: 'shell', name: 'Host Shell', type: 'shell' }, location.origin);
    } catch (e) {}
  }
  if (isCapture) {
    const cnode = capQ.get('node'), ciface = capQ.get('iface') || '0';
    const cname = capQ.get('name') || `Capture ${cnode}`;
    const cid = `cap-${cnode}-${ciface}`;
    nodesEl.style.display = 'none';   // captures.html provides the sidebar; hide the per-iframe one
    list.textContent = 'Packet capture session.';
    // html5 capture lane: pnet-capture-web serves an http packet UI, rendered via
    // the http reverse-proxy embed (_mountHttp), not a guac VNC/RDP tab. type:'http'
    // routes _mount -> _mountHttp; the capture marker makes _mint request
    // ?type=http&capture=1. (The native html5-off local-Wireshark lane is separate.)
    tabs.openNode({ id: cid, name: cname, type: 'http', capture: { node: cnode, iface: ciface } });
    try {
      if (window.parent && window.parent !== window)
        window.parent.postMessage({ pnq: 'title', node: cid, name: cname, type: 'http' }, location.origin);
    } catch (e) {}
  }

  // eve-ng graphical desktop dockers (eve-chrome/firefox/desktop-noble) serve an
  // RDP desktop, not a telnet line. The stock docker template defaults `console`
  // to 'telnet' (templates/intel/docker.yml), so such a node would otherwise open
  // an empty telnet tab. Recognise them by image so they ride the rdp lane.
  const GRAPHICAL_DOCKER = /eve-(?:chrome|firefox|desktop)-/i;

  // Map the engine console type to a console lane. telnet + docker 'bash' are
  // both telnet-lane (device.php maps both to telnet); 'vnc' is its own lane
  // (Slice 2); 'rdp' + 'rdp-tls' both ride the rdp lane (Slice 3) — guacd's
  // protocol is 'rdp' either way, token_mint pins security=tls for rdp-tls. An
  // EMPTY console type means telnet — IOL nodes report '' but serve a telnet
  // line (mirrors device.php::getConsoleUrl() default: telnet). When the console
  // type would default to telnet but the node is a graphical desktop docker,
  // promote it to rdp (an explicit rdp/vnc console type is always respected).
  const laneOf = (c, image) => {
    const base =
      (!c || c === 'telnet' || c === 'bash') ? 'telnet'
      : (c === 'rdp' || c === 'rdp-tls')     ? 'rdp'
      : (c === 'http' || c === 'https')      ? 'http'
      : c;
    if (base === 'telnet' && image && GRAPHICAL_DOCKER.test(image)) return 'rdp';
    return base;
  };

  // When embedded under the in-lab launcher, expose a per-node "open in its own
  // window" action (side-by-side viewing). Null when standalone (e.g. New-Tab).
  function detachFn() {
    try {
      if (window.parent && window.parent !== window && typeof window.parent.pnqDetachWebConsole === 'function')
        return window.parent.pnqDetachWebConsole;
    } catch (e) {}
    return null;
  }

  function addButton(node) {
    const lane = laneOf(node.console, node.image);
    const row = document.createElement('div');
    row.className = 'node-row';
    row.dataset.nid = String(node.id);
    const btn = document.createElement('button');
    btn.className = 'node-open';
    // Show the effective console type (an empty IOL console is the telnet lane;
    // a graphical docker promoted off telnet shows its real rdp lane, not 'telnet').
    const badge = node.console ? (laneOf(node.console) === lane ? node.console : lane) : lane;
    const dot = node.status === 2 ? '<span class="status-dot active" title="Running"></span>' : '<span class="status-dot" title="Stopped"></span>';
    btn.innerHTML = `${dot}${node.name}<span class="badge">${badge}</span>`;
    row.append(btn);
    if (lane === 'telnet' || lane === 'vnc' || lane === 'rdp' || lane === 'http') {
      btn.addEventListener('click', () => tabs.openNode({ id: node.id, name: node.name, type: lane, isDocker: node.nodeType === 'docker', isVpcs: node.nodeType === 'vpcs' }));
      const detach = detachFn();
      if (detach) {                     // ↗ detach: open in its own window + remove from combined tabs
        const d = document.createElement('button');
        d.className = 'node-detach';
        d.innerHTML = '&#x2197;';
        d.title = 'Detach to its own window (removes tab from this console)';
        d.addEventListener('click', () => {
          tabs.close(node.id);   // remove from combined console first
          detach(node.id);       // then open standalone window
        });
        row.append(d);
      }
    } else {
      // Any other graphical lane (spice/…) isn't wired yet — show, don't pretend.
      btn.disabled = true;
      btn.title = `${node.console} console: available in a later release`;
      btn.style.opacity = '0.5';
    }
    list.append(row);
  }

  // Real running topology: the nodes API exposes each node's console type + name.
  // (Skipped in capture/shell mode — those windows host a single dedicated tab.)
  // A freshly-opened topology is seeded asynchronously. If this window is opened
  // while that first seed is still materialising the lab's runtime node table,
  // the nodes API can briefly fail or return an empty table. Do not make that result
  // permanent: the old one-shot fetch returned before installing the status poll,
  // so only reloading the parent topology caused the console to try again.
  const NODE_LOAD_DELAYS = [250, 500, 1000];
  const fetchNodes = async () => {
    let lastError = null;
    for (let attempt = 0; attempt <= NODE_LOAD_DELAYS.length; attempt += 1) {
      try {
        const r = await fetch('/api/labs/session/nodes', { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) throw new Error(`nodes API ${r.status}`);
        const j = await r.json();
        if (!j || j.status !== 'success') throw new Error((j && j.message) || 'nodes API failed');
        const data = j.data || {};
        const entries = Array.isArray(data)
          ? data.map((n) => [n.id, n])
          : Object.entries(data);
        if (entries.length || attempt >= NODE_LOAD_DELAYS.length) return entries;
      } catch (e) {
        lastError = e;
        if (attempt >= NODE_LOAD_DELAYS.length) throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, NODE_LOAD_DELAYS[attempt]));
    }
    throw lastError || new Error('nodes API failed');
  };

  function renderNodes(entries) {
    list.textContent = '';
    if (!entries.length) {
      list.textContent = 'No nodes in the running lab.';
      return [];
    }
    const nodes = entries
        .map(([id, n]) => ({ id: String(n.id ?? id), name: n.name || `Node ${id}`, console: n.console, image: n.image, status: n.status ?? 0, nodeType: n.type || '' }))
        .sort((a, b) => Number(a.id) - Number(b.id));
    nodes.forEach(addButton);
    return nodes;
  }

  // Fetch + render is deliberately reusable: the header refresh button calls the
  // same path as initial load. Keep it single-flight so repeated clicks cannot
  // race and let an older response overwrite a newer node list.
  let nodeLoadPromise = null;
  function setRefreshBusy(busy) {
    if (!refreshEl) return;
    refreshEl.disabled = busy;
    refreshEl.classList.toggle('is-loading', busy);
    refreshEl.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (!busy) refreshEl.title = 'Refresh node list';
  }
  function loadNodes() {
    if (nodeLoadPromise) return nodeLoadPromise;
    list.setAttribute('aria-busy', 'true');
    setRefreshBusy(true);
    nodeLoadPromise = fetchNodes()
      .then((entries) => ({ entries, nodes: renderNodes(entries) }))
      .finally(() => {
        list.removeAttribute('aria-busy');
        setRefreshBusy(false);
        nodeLoadPromise = null;
      });
    return nodeLoadPromise;
  }
  function reportNodeLoadError(error, action) {
    const message = error && error.message ? error.message : 'nodes API failed';
    if (!list.querySelector('.node-row')) list.textContent = `Could not ${action} nodes: ${message}`;
    if (refreshEl) refreshEl.title = `Could not refresh nodes: ${message}. Click to retry.`;
  }

  if (refreshEl && !isCapture && !isShell && !isSingleNode) {
    refreshEl.addEventListener('click', (event) => {
      event.stopPropagation();
      loadNodes().catch((error) => reportNodeLoadError(error, 'refresh'));
    });
  }

  if (!isCapture && !isShell) {
    loadNodes()
    .then(({ entries, nodes }) => {

      // Poll every 5 s and update status dots so a node that starts while the
      // console is open transitions from grey to green without a page reload.
      const updateDots = () => {
        fetch('/api/labs/session/nodes', { credentials: 'same-origin' })
          .then((r) => r.ok ? r.json() : null)
          .then((j) => {
            if (!j || !j.data) return;
            const src = Array.isArray(j.data) ? j.data.map((n) => [n.id, n]) : Object.entries(j.data);
            src.forEach(([id, n]) => {
              const row = list.querySelector(`[data-nid="${CSS.escape(String(n.id ?? id))}"]`);
              if (!row) return;
              const dot = row.querySelector('.status-dot');
              if (!dot) return;
              const live = (n.status ?? 0) === 2;
              dot.classList.toggle('active', live);
              dot.title = live ? 'Running' : 'Stopped';
            });
          })
          .catch(() => {});
      };
      const _pollTimer = setInterval(updateDots, 5000);
      window.addEventListener('pagehide', () => clearInterval(_pollTimer), { once: true });

      // console.html?all=1 (quickbar "Console All"): open every console-capable
      // node as a tab in this one combined window.
      if (capQ.get('all') === '1') {
        nodes.forEach((n) => {
          const lane = laneOf(n.console, n.image);
          if (lane === 'telnet' || lane === 'vnc' || lane === 'rdp') tabs.openNode({ id: n.id, name: n.name, type: lane, isDocker: n.nodeType === 'docker', isVpcs: n.nodeType === 'vpcs' });
        });
      }

      // console.html?nodes=<csv> (session restore): reopen exactly these tabs.
      const wantNodes = (capQ.get('nodes') || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (wantNodes.length) {
        wantNodes.forEach((id) => {
          const m = nodes.find((n) => String(n.id) === String(id));
          if (!m) return;
          const lane = laneOf(m.console, m.image);
          if (lane === 'telnet' || lane === 'vnc' || lane === 'rdp') tabs.openNode({ id: m.id, name: m.name, type: lane, isDocker: m.nodeType === 'docker', isVpcs: m.nodeType === 'vpcs' });
        });
      }

      // Optional deep-link: console.html?node=<id>&type=telnet auto-opens a node.
      // ?second=1&lane=<telnet|vnc|rdp> instead opens that node's SECOND console
      // (console_2nd / second port) as its own tab, keyed "<id>::2" so it can sit
      // beside the primary. The launcher supplies the 2nd lane (it reads the node's
      // console_2nd from the topology); it's validated here and again, authoritatively,
      // server-side by token_mint (?second=1).
      const q = new URLSearchParams(location.search);
      const wantId = q.get('node');
      if (wantId) {
        const hit = entries.find(([id, n]) => String(n.id ?? id) === wantId);
        if (hit) {
          const n = hit[1];
          const nm = n.name || `Node ${wantId}`;
          const wantSecond = q.get('second') === '1';
          let wlane, tabId, tabName, second;
          if (wantSecond) {
            // Resolve the 2nd lane from the node's console_2nd (authoritative API
            // data); fall back to the launcher-supplied ?lane= hint only if absent.
            wlane = laneOf(n.console_2nd || q.get('lane') || '', n.image);
            tabId = wantId + '::2'; tabName = nm + ' (2)'; second = true;
          } else {
            wlane = laneOf(n.console, n.image);
            tabId = wantId; tabName = nm; second = false;
          }
          if (wlane === 'telnet' || wlane === 'vnc' || wlane === 'rdp') {
            tabs.openNode({ id: tabId, nodeId: wantId, name: tabName, type: wlane, second, isDocker: (n.type || '') === 'docker', isVpcs: (n.type || '') === 'vpcs' });
            // tell the parent launcher the node name + lane so a detached window can
            // title itself and "pop in" can re-open the right console lane in main.
            // (Skipped for the 2nd console — the launcher already titled that window.)
            if (!wantSecond) try {
              if (window.parent && window.parent !== window)
                window.parent.postMessage({ pnq: 'title', node: wantId, name: nm, type: wlane }, location.origin);
            } catch (e) {}
          }
        }
      }
    })
    .catch((error) => reportNodeLoadError(error, 'load'));
  }
