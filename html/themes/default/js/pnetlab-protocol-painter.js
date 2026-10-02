/**
 * pnetlab-protocol-painter.js — a dedicated left-pane (#lab-sidebar) launcher for
 * the Topology Overlays (OSPF SPF tree / BGP best-path map / EIGRP successor map).
 *
 * WHY: the overlays were only reachable by right-clicking a link, which forces the
 * root to one of that link's two endpoints — so you couldn't, say, paint EIGRP
 * rooted at R1 to see its tunnel-learned prefixes if you clicked a link near R5.
 * This panel lets you choose BOTH the protocol AND the root node explicitly, then
 * hands off to the same window.pnqOverlay* entry points (which run the picker for
 * BGP/EIGRP). The overlay engine (pnetlab-topology-overlay.js) must load first;
 * index.html orders this script right after it (both deferred = ordered).
 */
(function () {
  'use strict';

  var PROTO_KEY = 'pnq_pp_proto';   // remember last protocol
  var ROOT_KEY = 'pnq_pp_root';     // remember last root node id
  var PANEL_ID = 'pnq-pp-panel';

  var PROTOS = [
    { v: 'route', t: 'Route Path (any protocol)' },
    { v: 'eigrp', t: 'EIGRP Successor Map' },
    { v: 'ospf', t: 'OSPF SPF Tree' },
    { v: 'bgp', t: 'BGP Best-Path Map' },
    { v: 'stp', t: 'STP / RSTP' },
    { v: 'mst', t: 'STP (MST) — Instance' }
  ];

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    if (p && p.parentNode) p.parentNode.removeChild(p);
  }

  /* Hand off to the right overlay entry point. OSPF paints directly (no prefix);
     BGP/EIGRP open a prefix picker, STP a VLAN picker. For STP the chosen node is
     just where the VLAN list is read (the root bridge is computed). All take an
     explicit root/source node id. */
  function paint(proto, rootId) {
    closePanel();
    if (proto === 'route' && typeof window.pnqOverlayRoutePick === 'function') {
      window.pnqOverlayRoutePick(rootId);   // protocol-agnostic FIB trace
    } else if (proto === 'ospf' && typeof window.pnqOverlayOSPF === 'function') {
      window.pnqOverlayOSPF(rootId);
    } else if (proto === 'bgp' && typeof window.pnqOverlayBGPPick === 'function') {
      window.pnqOverlayBGPPick(rootId);
    } else if (proto === 'eigrp' && typeof window.pnqOverlayEIGRPPick === 'function') {
      window.pnqOverlayEIGRPPick(rootId);
    } else if (proto === 'stp' && typeof window.pnqOverlaySTPRoots === 'function') {
      window.pnqOverlaySTPRoots(rootId);   // VLAN list w/ root bridge -> click paints
    } else if (proto === 'mst' && typeof window.pnqOverlayMSTPick === 'function') {
      window.pnqOverlayMSTPick(rootId);
    } else if (typeof addMessage === 'function') {
      addMessage('danger', 'Topology overlay engine not loaded');
    }
  }

  function buildPanel(nodes) {
    closePanel();
    var savedProto = localStorage.getItem(PROTO_KEY) || 'eigrp';
    var savedRoot = localStorage.getItem(ROOT_KEY);

    var box = el('div', 'pnq-ov-legend'); box.id = PANEL_ID;
    var head = el('div', 'pnq-ov-head');
    head.appendChild(el('span', 'pnq-ov-title', 'Protocol Painter'));
    var close = el('button', 'pnq-ov-clear', 'Close');
    close.addEventListener('click', closePanel);
    head.appendChild(close);
    box.appendChild(head);

    var hint = el('div', 'pnq-ov-row pnq-pp-hint',
      'Paint a protocol’s computed picture onto the canvas.');
    box.appendChild(hint);

    // Protocol dropdown
    var pf = el('div', 'pnq-pp-field');
    pf.appendChild(el('label', null, 'Protocol'));
    var protoSel = el('select'); protoSel.id = 'pnq-pp-proto';
    PROTOS.forEach(function (p) {
      var o = el('option', null, p.t); o.value = p.v;
      if (p.v === savedProto) o.selected = true;
      protoSel.appendChild(o);
    });
    function applyHint() {
      var v = protoSel.value;
      hint.textContent = (v === 'stp')
        ? 'STP/RSTP: lists each VLAN with its root bridge — click a VLAN to paint its tree.'
        : (v === 'mst')
        ? 'MST: Root = the node to read the region’s instances from — pick an MST instance to paint.'
        : 'Paint a protocol’s computed picture onto the canvas.';
    }
    protoSel.addEventListener('change', applyHint);
    pf.appendChild(protoSel);
    box.appendChild(pf);
    applyHint();

    // Root-node dropdown (running console nodes only)
    var rf = el('div', 'pnq-pp-field');
    rf.appendChild(el('label', null, 'Root'));
    var rootSel = el('select'); rootSel.id = 'pnq-pp-root';
    if (!nodes.length) {
      var o0 = el('option', null, 'no running nodes'); o0.value = '';
      rootSel.appendChild(o0); rootSel.disabled = true;
    } else {
      nodes.forEach(function (n) {
        var o = el('option', null, n.name + '  (node ' + n.node_id + ')');
        o.value = n.node_id;
        if (savedRoot != null && String(n.node_id) === String(savedRoot)) o.selected = true;
        rootSel.appendChild(o);
      });
    }
    rf.appendChild(rootSel);
    box.appendChild(rf);

    // Paint button
    var go = el('button', 'pnq-pp-paint', 'Paint');
    go.disabled = !nodes.length;
    go.addEventListener('click', function () {
      var proto = protoSel.value, root = rootSel.value;
      if (!root) return;
      localStorage.setItem(PROTO_KEY, proto);
      localStorage.setItem(ROOT_KEY, root);
      paint(proto, root);
    });
    box.appendChild(go);

    document.body.appendChild(box);
  }

  /* Open: fetch the running console nodes (same list the overlays use) then show
     the panel. A short busy note keeps the panel slot from flashing empty. */
  function openPanel(e) {
    if (e) e.preventDefault();
    closePanel();
    // Pre-warm the CDP topology cache now, in the background, so the paint that
    // follows the user's protocol/VLAN choice only reads the per-VLAN state and is
    // fast. Fire-and-forget; the gather is serialised server-side so it can't
    // collide with the VLAN-list/paint reads that come next.
    try {
      fetch('/pnq-overlay.php', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cdp-warm' })
      }).catch(function () {});
    } catch (e2) {}
    var busy = el('div', 'pnq-ov-legend', 'Loading nodes…'); busy.id = PANEL_ID;
    document.body.appendChild(busy);
    fetch('/pnq-overlay.php?list=1', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var nodes = (res && res.nodes) ? res.nodes.slice() : [];
        nodes.sort(function (a, b) {
          return String(a.name).localeCompare(String(b.name),
            undefined, { numeric: true });
        });
        buildPanel(nodes);
      })
      .catch(function () { buildPanel([]); });
  }
  // let the overlay result panels reopen the painter ("‹ Painter" back button)
  window.pnqOpenProtocolPainter = openPanel;

  /* ── inject the sidebar entry (mirror pnetlab-sidebar-tools.js) ──────────── */
  function inject() {
    if (document.getElementById('pnq-protopainter')) return true;
    var ul = document.querySelector('#lab-sidebar ul');
    if (!ul) return false;
    var li = el('li');
    li.id = 'pnq-protopainter';
    li.innerHTML = '<a href="javascript:void(0)" title="Paint OSPF / BGP / EIGRP onto the canvas">' +
      '<i class="fa fa-paint-brush" style="font-size:15px;"></i>' +
      '<span class="lab-sidebar-title">Protocol Painter</span></a>';
    li.querySelector('a').addEventListener('click', openPanel);
    // place right after the Network Watcher entry when present, else append
    var anchor = document.getElementById('pnq-linklabels-toggle');
    if (anchor && anchor.parentNode === ul) ul.insertBefore(li, anchor.nextSibling);
    else ul.appendChild(li);
    return true;
  }

  function init() {
    if (inject()) return;
    var mo = new MutationObserver(function () { if (inject()) mo.disconnect(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
