/* captures-init.js — externalized from captures.html (CSP forbids inline
   scripts). */
(function () {
  'use strict';
  var tabsEl  = document.getElementById('captabs');
  var panesEl = document.getElementById('cappanes');
  // Per-capture model: each capture streams its OWN pnet-wireshark VNC container
  // (console.html?capture=1&node&iface). Tabs are DEDUPED by URL so the same
  // capture clicked twice reuses its pane.
  var caps  = new Map();                       // key -> { desc, tab, url }
  var panes = new Map();                       // url -> { pane, refs:Set<key> }
  var bc = ('BroadcastChannel' in window) ? new BroadcastChannel('pnq-captures') : null;

  function keyOf(d) { return d.key || ('cap-' + d.node + '-' + d.iface); }
  function singleUrl(d) {
    return d.url || ('/console/console.html?capture=1&node=' + encodeURIComponent(d.node) +
      '&iface=' + encodeURIComponent(d.iface) + '&name=' + encodeURIComponent(d.name || ''));
  }
  // Ask the opener (which holds the lab session) to raise this capture's
  // Wireshark window inside the shared desktop (legacy; harmless per-container).
  function focusCapture(d) {
    if (bc && d && d.node != null) {
      try { bc.postMessage({ type: 'focus', node: d.node, iface: d.iface }); } catch (e) {}
    }
  }
  function updateEmpty() {
    var empty = tabsEl.querySelector('.cap-empty');
    if (caps.size && empty) empty.remove();
    else if (!caps.size && !empty) { tabsEl.innerHTML = '<div class="cap-empty">No captures yet.</div>'; }
  }

  function activate(key) {
    var active = caps.get(key);
    var activeUrl = active ? active.url : null;
    panes.forEach(function (p, url) { p.pane.style.display = (url === activeUrl) ? '' : 'none'; });
    caps.forEach(function (c, k) { c.tab.classList.toggle('active', k === key); });
  }

  // silent=true: removal that must NOT tear the capture down — opener-side
  // eviction (its capture relaunch restarts the container itself) and pop-out
  // (the capture lives on in its own window). A non-silent remove is the user
  // clicking the tab's ✕: broadcast 'closed' with teardown so the opener stops
  // and removes the capture container (wireshark/delete) — without it the
  // container kept running and dumpcap kept accumulating packets forever.
  function remove(key, silent) {
    var c = caps.get(key);
    if (!c) return;
    c.tab.remove();
    caps.delete(key);
    var p = panes.get(c.url);
    if (p) {
      p.refs.delete(key);
      if (p.refs.size === 0) { p.pane.remove(); panes.delete(c.url); }  // last ref -> drop iframe
    }
    if (!silent && bc) { try { bc.postMessage({ type: 'closed', key: key, teardown: true }); } catch (e) {} }
    var next = caps.keys().next().value;
    if (next) activate(next);
    updateEmpty();
  }

  // Pop this capture OUT into its own in-lab window (each capture is its own
  // pnet-wireshark VNC container, so a second window is a fresh client — safe).
  // Removing it from the aggregator keeps a single VNC connection to the
  // container. SILENT removal: the capture stays alive (and stays in the
  // opener's descriptor list) — a teardown broadcast here would kill the very
  // container being popped out.
  function popout(key) {
    var c = caps.get(key);
    if (!c) return;
    var u = c.url, name = c.desc.name || (c.tab.querySelector('.cap-label') || {}).textContent || 'Capture';
    try {
      if (window.parent && window.parent !== window && typeof window.parent.pnqOpenConsoleWindow === 'function') {
        window.parent.pnqOpenConsoleWindow(u, key + '-pop', name);
        remove(key, true); return;
      }
    } catch (e) {}
    window.open(u, key + '-pop');
    remove(key, true);
  }

  function add(desc) {
    var key = keyOf(desc);
    if (caps.has(key)) { activate(key); return; }
    var url = singleUrl(desc);

    var tab = document.createElement('div'); tab.className = 'cap-tab';
    var label = document.createElement('div'); label.className = 'cap-label';
    label.textContent = desc.name || (desc.src ? (desc.dst ? desc.src + ' → ' + desc.dst : desc.src) : key);
    tab.title = label.textContent;
    var pop = document.createElement('div'); pop.className = 'cap-btn cap-pop'; pop.innerHTML = '&#x2197;';
    pop.title = 'Pop out into its own window';
    var close = document.createElement('div'); close.className = 'cap-btn cap-close'; close.innerHTML = '&times;';
    close.title = 'Stop capture and close';
    tab.append(label, pop, close);
    tab.addEventListener('click', function () { activate(key); focusCapture(desc); });
    pop.addEventListener('click', function (e) { e.stopPropagation(); popout(key); });
    close.addEventListener('click', function (e) { e.stopPropagation(); remove(key); });
    tabsEl.append(tab);

    // reuse the pane for this URL if one already exists
    var p = panes.get(url);
    if (!p) {
      var pane = document.createElement('div'); pane.className = 'cap-pane'; pane.style.display = 'none';
      var frame = document.createElement('iframe');
      frame.src = url;
      frame.setAttribute('title', label.textContent);
      pane.append(frame);
      panesEl.append(pane);
      p = { pane: pane, refs: new Set() };
      panes.set(url, p);
    }
    p.refs.add(key);

    caps.set(key, { desc: desc, tab: tab, url: url });
    updateEmpty();
    activate(key);
    focusCapture(desc);
  }

  if (bc) {
    bc.onmessage = function (e) {
      var m = e.data; if (!m) return;
      if (m.type === 'add' && m.desc) add(m.desc);
      else if (m.type === 'replay' && Array.isArray(m.list)) m.list.forEach(add);
      // Opener evicted a capture (relaunch restarts its container): drop the
      // old tab + iframe so the follow-up 'add' builds a FRESH pane. Without
      // this, add() dedupes on the key and re-shows the dead RDP session's
      // frozen framebuffer — the "old data" bug.
      else if (m.type === 'closed' && m.key) remove(m.key, true);
    };
    bc.postMessage({ type: 'hello' });        // ask the opener to replay active captures
    // Whole-window close (vs a per-tab ✕): tell the opener the captures window is
    // going away so it tears down EVERY still-open capture container — otherwise
    // closing the window leaks the containers (dumpcap keeps running). We do NOT
    // tear down here: a refresh also fires pagehide, so the opener waits a short
    // grace that the reload's 'hello' cancels, distinguishing close from refresh.
    window.addEventListener('pagehide', function () {
      try { bc.postMessage({ type: 'window-closing' }); } catch (e) {}
    });
  }

  // Deep-link fallback (also covers browsers without BroadcastChannel): the first
  // capture may arrive as ?node=&iface=&name=&src=&dst= on this page's URL.
  var q = new URLSearchParams(location.search);
  if (q.get('node')) {
    add({ node: q.get('node'), iface: q.get('iface') || '0',
          name: q.get('name') || '', src: q.get('src') || '', dst: q.get('dst') || '' });
  }
})();
