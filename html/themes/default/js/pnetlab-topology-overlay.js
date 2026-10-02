/* pnetlab-topology-overlay.js — Topology Overlays (Protocol Inspector sibling).
 *
 * Right-click a link -> "OSPF SPF Tree": POST pnq-overlay.php {action:'ospf',
 * root_node_id} -> the server gathers CDP/LLDP + `show ip ospf interface brief`
 * across the running nodes, runs Dijkstra, and returns the SPF tree mapped onto
 * canvas node-pairs. We paint it: tree links glow green (with the OSPF cost in
 * the tree direction), ECMP links dash, off-tree links dim, the root node gets a
 * halo, and a legend lists the result + warnings + a Clear button.
 *
 * Reuses the jsPlumb access proven by pnetlab-egress-glow.js (window.lab_topology
 * .getAllConnections(); connection sourceId/targetId = 'node<id>'/'network<id>';
 * connector.canvas = the link's SVG). The recolour is a CSS class on that SVG
 * (CSS `stroke` beats jsPlumb's presentation attribute), so Clear just removes
 * the class — we never mutate jsPlumb paint state we'd have to reconstruct.
 *
 * CSP-safe: no inline styles/handlers; delegated listeners; DOM built in code.
 */
(function () {
  'use strict';

  var touched = [];     // [{svg, cls}]  connectors we added a class to
  var overlayIds = [];  // [{conn, id}]  cost-label overlays we added
  var rootEl = null;    // node element wearing the halo
  var originEls = [];   // node elements marked as BGP prefix origins / tunnel peers
  var lastRun = {};     // {proto, reqRoot, reqAlt, prefix} — for the root swap
  var vlines = [];      // [{from:'nodeID', to:'nodeID'}] virtual (tunnel) links
  var vlineSvg = null;  // the viewport SVG that hosts them
  var vlineRAF = 0;     // rAF handle keeping the lines glued to the nodes
  var stpWatch = false; // STP "watch convergence" live re-poll active?
  var stpWatchT = 0;    // its setTimeout handle
  var stpWatchN = 0;    // poll count (bounded so it can't grab consoles forever)
  // remembered drag position lives on window.pnqOvLegendPos (set by the shared
  // panel-drag handler in pnetlab-lazy-overlays.js) so a re-render (e.g. STP watch
  // re-poll) keeps the panel where the user put it.
  var lastStpRes = null; // last STP paint result — names + addr2node for why-popup

  function jp() {
    var j = window.lab_topology;
    return (j && j.getAllConnections) ? j : null;
  }

  /* Connections to paint for an undirected node pair. Direct node<->node first
     (p2p); else node<->network<->node (a shared LAN drawn through a blob): paint
     both segments that join the pair through one network. */
  function connsForPair(a, b) {
    var j = jp();
    if (!j) return [];
    var A = 'node' + a, B = 'node' + b;
    var all = j.getAllConnections();
    var direct = [];
    var byNet = {};          // netId -> {a:[conns], b:[conns]}
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      var s = c.sourceId || (c.source && c.source.id) || '';
      var t = c.targetId || (c.target && c.target.id) || '';
      if ((s === A && t === B) || (s === B && t === A)) { direct.push(c); continue; }
      var nodeEnd = null, netEnd = null;
      if (s === A && t.indexOf('network') === 0) { nodeEnd = 'a'; netEnd = t; }
      else if (t === A && s.indexOf('network') === 0) { nodeEnd = 'a'; netEnd = s; }
      else if (s === B && t.indexOf('network') === 0) { nodeEnd = 'b'; netEnd = t; }
      else if (t === B && s.indexOf('network') === 0) { nodeEnd = 'b'; netEnd = s; }
      if (netEnd) {
        (byNet[netEnd] = byNet[netEnd] || { a: [], b: [] })[nodeEnd].push(c);
      }
    }
    if (direct.length) return direct;
    for (var n in byNet) {
      if (byNet[n].a.length && byNet[n].b.length) {
        return byNet[n].a.concat(byNet[n].b);   // both legs of the shared LAN
      }
    }
    return [];
  }

  function svgOf(conn) {
    return (conn.connector && conn.connector.canvas) || conn.canvas || null;
  }

  /* Interface id reduced to its numeric part so "e0/2" (GUI label) and "Et0/2"
     (IOS show output) compare equal — lets us match a link to its connector. */
  function ifNum(s) { return String(s || '').trim().toLowerCase().replace(/^[a-z]+/, ''); }

  function connLabelNums(conn) {
    var out = [];
    if (!conn.getOverlays) return out;
    var ovs = conn.getOverlays();
    for (var id in ovs) {
      var o = ovs[id];
      var t = (o && o.getLabel) ? o.getLabel() : (o && o.canvas ? o.canvas.textContent : null);
      if (t != null) {
        var s = String(t).replace(/<[^>]*>/g, '').trim();
        var n = s ? ifNum(s) : '';
        if (n) out.push(n);
      }
    }
    return out;
  }

  /* Bucket a connector's interface-name overlays by WHICH END they sit on
     (nearest the a-node vs the b-node). -> {a:[nums], b:[nums]}. Lets us match a
     link to its connector by the ORDERED interface pair, not an unordered set —
     so crossed parallel links (SW5 e0/2->SW6 e0/3 vs SW5 e0/3->SW6 e0/2, same
     set {0/2,0/3}) are still told apart. */
  function connEndNums(conn, aElId, bElId) {
    var res = { a: [], b: [] };
    var na = document.getElementById(aElId), nb = document.getElementById(bElId);
    if (!conn.getOverlays || !na || !nb) return res;
    var ra = na.getBoundingClientRect(), rb = nb.getBoundingClientRect();
    var ax = ra.left + ra.width / 2, ay = ra.top + ra.height / 2;
    var bx = rb.left + rb.width / 2, by = rb.top + rb.height / 2;
    var ovs = conn.getOverlays();
    for (var id in ovs) {
      var o = ovs[id];
      var t = (o && o.getLabel) ? o.getLabel() : (o && o.canvas ? o.canvas.textContent : null);
      if (t == null || !o.canvas) continue;
      var n = ifNum(String(t).replace(/<[^>]*>/g, '').trim());
      if (!n || !/\d/.test(n)) continue;          // skip our own R/D/?/A·BLK badges
      var r = o.canvas.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var da = (cx - ax) * (cx - ax) + (cy - ay) * (cy - ay);
      var db = (cx - bx) * (cx - bx) + (cy - by) * (cy - by);
      (da <= db ? res.a : res.b).push(n);
    }
    return res;
  }

  /* The specific connector for ONE physical link between a and b. With parallel
     links connsForPair returns several; match by the ORDERED interface pair
     (a_if near node a AND b_if near node b). Falls back to either-end, then [0]. */
  function connForLink(a, b, aIf, bIf) {
    var conns = connsForPair(a, b);
    if (conns.length <= 1) return conns[0] || null;
    var ka = ifNum(aIf), kb = ifNum(bIf);
    var aEl = 'node' + a, bEl = 'node' + b, single = null;
    for (var i = 0; i < conns.length; i++) {
      var ends = connEndNums(conns[i], aEl, bEl);
      var hitA = ka && ends.a.indexOf(ka) !== -1;
      var hitB = kb && ends.b.indexOf(kb) !== -1;
      if (hitA && hitB) return conns[i];          // exact ordered match
      var all = ends.a.concat(ends.b);
      if (!single && ((ka && all.indexOf(ka) !== -1) || (kb && all.indexOf(kb) !== -1))) {
        single = conns[i];
      }
    }
    return single || conns[0];
  }

  function addClass(conn, cls) {
    var svg = svgOf(conn);
    if (svg && svg.classList && !svg.classList.contains(cls)) {
      svg.classList.add(cls);
      touched.push({ svg: svg, cls: cls });
    }
  }

  function addCost(conn, text, mod, loc) {
    if (!conn.addOverlay) return;
    var id = 'pnq-ov-cost-' + Math.random().toString(36).slice(2);
    try {
      conn.addOverlay(['Label', {
        label: '<span class="pnq-ov-cost-lbl' + (mod ? ' ' + mod : '') + '">' + text + '</span>',
        location: (loc != null ? loc : 0.5), id: id, cssClass: 'pnq-ov-cost-ovl'
      }]);
      overlayIds.push({ conn: conn, id: id });
    } catch (e) { /* overlay API mismatch — cost label is optional */ }
  }

  /* Clickable "?" badge at a blocked link's midpoint -> explains why it blocked.
     Carries vlan/node/iface so the delegated handler can query that port. */
  function addWhyBadge(conn, vlan, node, iface, mst) {
    if (!conn.addOverlay) return;
    var id = 'pnq-ov-why-' + Math.random().toString(36).slice(2);
    try {
      conn.addOverlay(['Label', {
        location: 0.5, id: id, cssClass: 'pnq-ov-cost-ovl',
        label: '<span class="pnq-ov-cost-lbl pnq-ov-why" data-vlan="' + vlan
          + '" data-node="' + node + '" data-iface="' + iface
          + '" data-mst="' + (mst ? 1 : 0)
          + '" title="Why is this port blocked?">?</span>'
      }]);
      overlayIds.push({ conn: conn, id: id });
    } catch (e) { /* overlay API mismatch — why badge is optional */ }
  }

  /* Place a port-role badge near each END of a link, oriented to the right node
     by the connector's source (STP roles are per-port, so each end differs). */
  function addEndLabels(conn, aId, aText, aMod, bId, bText, bMod) {
    var srcA = (conn.sourceId || (conn.source && conn.source.id) || '') === aId;
    // Sit inboard of the ends (PNetLab's interface-name labels live at ~0.1/0.9)
    // and tag with 'rl' so CSS lifts the badge off the line — no label overlap.
    if (aText) addCost(conn, aText, 'rl ' + aMod, srcA ? 0.27 : 0.73);
    if (bText) addCost(conn, bText, 'rl ' + bMod, srcA ? 0.73 : 0.27);
  }

  /* ---- virtual (tunnel) links ------------------------------------------- */
  // A tunnel/off-canvas next-hop has no jsPlumb connector, so we draw our OWN
  // dashed line in a fixed, viewport-space SVG (NEVER jsPlumb.connect — that can
  // fire PNetLab's link-creation handler and make a real link). getBoundingClientRect
  // gives final on-screen positions, so a rAF loop keeps the line glued to the
  // nodes through pan / zoom / drag without touching the canvas transform math.
  var SVGNS = 'http://www.w3.org/2000/svg';
  function nodeCenter(id) {
    var n = document.getElementById(id);
    if (!n) return null;
    var r = n.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function drawVlines() {
    if (!vlineSvg) return;
    while (vlineSvg.firstChild) vlineSvg.removeChild(vlineSvg.firstChild);
    for (var i = 0; i < vlines.length; i++) {
      var a = nodeCenter(vlines[i].from), b = nodeCenter(vlines[i].to);
      if (!a || !b) continue;
      // Bow each line into a curve: a collinear pair (e.g. R1-R5-R3 stacked
      // vertically) would otherwise run straight over the physical links and
      // hide. Control point = midpoint pushed along the perpendicular; alternate
      // the side per line so multiple tunnels from one node fan out, not stack.
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var off = Math.max(28, Math.min(80, len * 0.22)) * (i % 2 ? -1 : 1);
      var cx = mx + (-dy / len) * off, cy = my + (dx / len) * off;
      var p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', 'M ' + a.x + ' ' + a.y + ' Q ' + cx + ' ' + cy
        + ' ' + b.x + ' ' + b.y);
      p.setAttribute('class', 'pnq-ov-vline');
      vlineSvg.appendChild(p);
    }
  }
  function vlineTick() { drawVlines(); vlineRAF = requestAnimationFrame(vlineTick); }
  function addVline(fromId, toId) {
    if (!vlineSvg) {
      vlineSvg = document.createElementNS(SVGNS, 'svg');
      vlineSvg.id = 'pnq-ov-vlines';
      vlineSvg.setAttribute('class', 'pnq-ov-vlines');
      document.body.appendChild(vlineSvg);
    }
    vlines.push({ from: fromId, to: toId });
    if (!vlineRAF) vlineTick();
  }
  function clearVlines() {
    vlines = [];
    if (vlineRAF) { cancelAnimationFrame(vlineRAF); vlineRAF = 0; }
    if (vlineSvg && vlineSvg.parentNode) vlineSvg.parentNode.removeChild(vlineSvg);
    vlineSvg = null;
  }

  function clearOverlay(keepWatch) {
    if (!keepWatch) stopStpWatch();   // paint() passes true so a watch re-poll survives
    clearVlines();
    for (var i = 0; i < touched.length; i++) {
      try { touched[i].svg.classList.remove(touched[i].cls); } catch (e) {}
    }
    touched = [];
    for (var k = 0; k < overlayIds.length; k++) {
      try { overlayIds[k].conn.removeOverlay(overlayIds[k].id); } catch (e) {}
    }
    overlayIds = [];
    if (rootEl) {
      try {
        rootEl.classList.remove('pnq-ov-root');
        rootEl.classList.remove('pnq-ov-stproot');
      } catch (e) {}
      rootEl = null;
    }
    for (var o = 0; o < originEls.length; o++) {
      try {
        originEls[o].classList.remove('pnq-ov-origin');
        originEls[o].classList.remove('pnq-ov-origin-eg');
        originEls[o].classList.remove('pnq-ov-offcanvas');
        originEls[o].classList.remove('pnq-ov-tunpeer');
      } catch (e) {}
    }
    originEls = [];
    var lg = document.getElementById('pnq-ov-legend');
    if (lg && lg.parentNode) lg.parentNode.removeChild(lg);
    var pk = document.getElementById('pnq-ov-picker');
    if (pk && pk.parentNode) pk.parentNode.removeChild(pk);
    var wb = document.getElementById('pnq-ov-whybox');
    if (wb && wb.parentNode) wb.parentNode.removeChild(wb);
  }
  window.pnqOverlayClear = clearOverlay;

  /* ---- legend ----------------------------------------------------------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* Re-apply a user-dragged position to a freshly built panel (so re-renders —
     e.g. the STP watch re-poll — don't snap it back to the default corner). */
  function applyPos(box) {
    var legendPos = window.pnqOvLegendPos;
    if (!legendPos) return;
    box.style.left = legendPos.left + 'px';
    box.style.top = legendPos.top + 'px';
    box.style.right = 'auto';
  }

  function showLegend(res) {
    var prev = document.getElementById('pnq-ov-legend');
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

    var names = res.names || {};
    var proto = res.proto;
    var isRoute = proto === 'route';
    // the protocol-agnostic Route Path reuses the BGP forwarding-path paint
    // (amber in_path links, ECMP dashes, origin halo) — same edge shape.
    var isBgp = proto === 'bgp' || isRoute, isEigrp = proto === 'eigrp';
    var isMst = proto === 'mst', isStp = proto === 'stp' || isMst;
    var hasPrefix = isBgp || isEigrp;
    var rootName = names[String(res.root)] || ('node ' + res.root);

    var box = el('div'); box.id = 'pnq-ov-legend'; box.className = 'pnq-ov-legend';
    var head = el('div', 'pnq-ov-head');
    var title = isRoute ? 'Route Path' : proto === 'bgp' ? 'BGP Best-Path'
      : isEigrp ? 'EIGRP Successor Map'
      : isMst ? 'STP (MST)' : isStp ? 'STP Port Roles' : 'OSPF SPF Tree';
    head.appendChild(el('span', 'pnq-ov-title', title));
    var close = el('button', 'pnq-ov-clear', 'Clear');
    head.appendChild(close);
    box.appendChild(head);

    if (isStp) {
      if (isMst) {
        box.appendChild(el('div', 'pnq-ov-row', 'MST instance ' + (res.instance != null ? res.instance : '?')
          + (res.region ? '  ·  region ' + res.region : '')
          + (res.revision != null ? ' rev ' + res.revision : '')));
        if (res.vlans_mapped) box.appendChild(el('div', 'pnq-ov-row', 'VLANs: ' + res.vlans_mapped));
      } else {
        box.appendChild(el('div', 'pnq-ov-row', 'VLAN ' + (res.vlan || '?')));
      }
      var rb = (res.root != null)
        ? ('Root bridge: ' + rootName + (res.root_prio != null ? '  (prio ' + res.root_prio + ')' : ''))
        : 'Root bridge: off-canvas' + (res.root_addr ? ' (' + res.root_addr + ')' : '');
      box.appendChild(el('div', 'pnq-ov-row', rb));
    } else {
      var rootRow = el('div', 'pnq-ov-row', 'Root: ' + rootName);
      // Offer a one-click flip to the link's OTHER endpoint as root.
      var other = null;
      [lastRun.reqRoot, lastRun.reqAlt].forEach(function (x) {
        if (x != null && x !== '' && String(x) !== String(res.root)) other = x;
      });
      if (other != null && names[String(other)]) {
        var sw = el('button', 'pnq-ov-swap', '⇄ ' + names[String(other)]);
        sw.setAttribute('data-other', other);
        sw.setAttribute('data-cur', res.root);
        sw.title = 'Re-root the overlay at ' + names[String(other)];
        rootRow.appendChild(sw);
      }
      box.appendChild(rootRow);
    }
    if (hasPrefix && res.prefix) box.appendChild(el('div', 'pnq-ov-row', 'Prefix: ' + res.prefix));
    if (hasPrefix && res.origin && res.origin.length) {
      box.appendChild(el('div', 'pnq-ov-row', 'Origin: ' + res.origin.map(function (n) {
        return names[String(n)] || n; }).join(', ')));
    }
    if (isStp) {
      var sfwd = 0, sblk = 0, str = 0;
      (res.edges || []).forEach(function (e) {
        if (e.transitioning) str++; else if (e.forwarding) sfwd++;
        else if (e.blocked) sblk++;
      });
      if (sfwd > 0) box.appendChild(el('div', 'pnq-ov-row', sfwd + ' forwarding link(s)'));
      if (sblk > 0) box.appendChild(el('div', 'pnq-ov-row', sblk + ' blocked link(s)'));
      if (str > 0) box.appendChild(el('div', 'pnq-ov-row pnq-ov-warn',
        str + ' converging (listen/learn)…'));
      var sg = el('div', 'pnq-ov-keys');
      [['sw-stp-fwd', 'forwarding'], ['sw-stp-blk', 'blocked'],
       ['sw-stp-trans', 'listen/learn']].forEach(function (k) {
        var ke = el('span', 'pnq-ov-key');
        ke.appendChild(el('i', 'pnq-ov-sw ' + k[0]));
        ke.appendChild(el('span', null, k[1]));
        sg.appendChild(ke);
      });
      box.appendChild(sg);
      box.appendChild(el('div', 'pnq-ov-row pnq-ov-offc-head', 'Port roles'));
      box.appendChild(el('div', 'pnq-ov-row pnq-ov-offc',
        'R Root · D Designated · A Alternate · B Backup'));
      // Watch convergence: re-poll every few seconds so listen→learn→forward
      // transitions animate live (opt-in — it grabs the single-client consoles).
      var wrow = el('div', 'pnq-ov-row');
      var wbtn = el('button', 'pnq-ov-swap' + (stpWatch ? ' pnq-ov-watch-on' : ''),
        stpWatch ? '■ Stop watching' : '▶ Watch convergence');
      wbtn.id = 'pnq-ov-watch';
      wbtn.style.marginLeft = '0';
      wrow.appendChild(wbtn);
      box.appendChild(wrow);

      // navigation: re-run this VLAN/instance, or step back to the VLAN/instance
      // list, or back to the Protocol Painter (node + protocol selector). All ride
      // the globals the painter and overlays already expose, so they re-fetch fresh.
      // NB: these use pnq-ov-navbtn, NOT pnq-ov-swap — the delegated swap handler
      // re-runs the overlay for ANY .pnq-ov-swap click and would fall through to
      // runOspf(null,null) ("node 0 is not in this lab"). Our own click handlers
      // below drive the right action.
      var nav = el('div', 'pnq-ov-row pnq-ov-nav');
      var rerun = el('button', 'pnq-ov-navbtn', '↻ Rerun');
      rerun.title = isMst
        ? 'Re-run STP for MST instance ' + (res.instance != null ? res.instance : '?')
        : 'Re-run STP for VLAN ' + (res.vlan || '?');
      rerun.addEventListener('click', function () {
        if (lastRun.proto === 'mst' && typeof window.pnqOverlayMST === 'function')
          window.pnqOverlayMST(lastRun.inst, lastRun.srcRoot);
        else if (typeof window.pnqOverlaySTP === 'function')
          window.pnqOverlaySTP(lastRun.vlan, lastRun.srcRoot);
      });
      nav.appendChild(rerun);
      if (lastRun.srcRoot != null && lastRun.srcRoot !== '') {
        var toList = el('button', 'pnq-ov-navbtn', isMst ? '‹ Instances' : '‹ VLANs');
        toList.title = 'Back to the ' + (isMst ? 'MST instance' : 'VLAN') + ' list';
        toList.addEventListener('click', function () {
          if (lastRun.proto === 'mst' && typeof window.pnqOverlayMSTPick === 'function')
            window.pnqOverlayMSTPick(lastRun.srcRoot);
          else if (typeof window.pnqOverlaySTPRoots === 'function')
            window.pnqOverlaySTPRoots(lastRun.srcRoot);
        });
        nav.appendChild(toList);
      }
      var toPainter = el('button', 'pnq-ov-navbtn', '‹ Painter');
      toPainter.title = 'Back to the Protocol Painter (choose node / protocol)';
      toPainter.addEventListener('click', function () {
        if (typeof window.pnqOpenProtocolPainter === 'function')
          window.pnqOpenProtocolPainter();
      });
      nav.appendChild(toPainter);
      box.appendChild(nav);
    } else if (isEigrp) {
      var fwd = 0, bkp = 0, nf = 0;
      (res.edges || []).forEach(function (e) {
        if (e.forwarding) fwd++; else if (e.backup) bkp++;
        else if (e.infeasible) nf++;
      });
      if (fwd > 0) box.appendChild(el('div', 'pnq-ov-row', fwd + ' forwarding link(s)'
        + (res.loadbalance ? '  ·  unequal-cost load-balancing' : '')));
      if (bkp > 0) box.appendChild(el('div', 'pnq-ov-row', bkp + ' feasible-successor backup(s)'));
      if (nf > 0) box.appendChild(el('div', 'pnq-ov-row', nf
        + ' excluded link(s) — failed feasibility (RD ≥ FD)'));
      if (fwd > 0 || bkp > 0 || nf > 0) {
        var elg = el('div', 'pnq-ov-keys');
        var e1 = el('span', 'pnq-ov-key');
        e1.appendChild(el('i', 'pnq-ov-sw sw-succ')); e1.appendChild(el('span', null, 'forwarding (S/FS)'));
        var e2 = el('span', 'pnq-ov-key');
        e2.appendChild(el('i', 'pnq-ov-sw sw-fs')); e2.appendChild(el('span', null, 'FS backup'));
        elg.appendChild(e1); elg.appendChild(e2);
        if (nf > 0) {
          var e4 = el('span', 'pnq-ov-key');
          e4.appendChild(el('i', 'pnq-ov-sw sw-nf')); e4.appendChild(el('span', null, 'not feasible'));
          elg.appendChild(e4);
        }
        var e3 = el('span', 'pnq-ov-key');
        e3.appendChild(el('i', 'pnq-ov-sw sw-dim')); e3.appendChild(el('span', null, 'off path'));
        elg.appendChild(e3);
        box.appendChild(elg);
      }
      // Off-canvas exits: a successor/FS that leaves via a tunnel/Null/off-canvas
      // peer can't be drawn as a link, so spell it out (node · role → iface (kind)).
      if (res.offcanvas && res.offcanvas.length) {
        var kindLbl = { tunnel: 'overlay tunnel', loopback: 'loopback',
          vlan: 'SVI', portchannel: 'port-channel', null: 'discard/summary',
          physical: 'off-canvas peer' };
        box.appendChild(el('div', 'pnq-ov-row pnq-ov-offc-head', 'Off-canvas exits'));
        res.offcanvas.forEach(function (o) {
          var who = names[String(o.node)] || ('node ' + o.node);
          var peer = (o.peer != null) ? (names[String(o.peer)] || ('node ' + o.peer)) : null;
          var txt = who + ' · ' + (o.role || 'S') + ' → ' + o.iface
            + ' (' + (kindLbl[o.kind] || o.kind) + ')'
            + (o.nexthop ? ' via ' + o.nexthop : '')
            + (peer ? ' → ' + peer : '');
          box.appendChild(el('div', 'pnq-ov-row pnq-ov-offc', txt));
        });
      }
    } else {
      var hot = isBgp ? 'in_path' : 'in_tree';
      var hotLinks = 0, ecmp = 0;
      (res.edges || []).forEach(function (e) {
        if (e[hot]) hotLinks++; if (e.ecmp && e[hot]) ecmp++;
      });
      if (hotLinks > 0) {
        box.appendChild(el('div', 'pnq-ov-row', hotLinks + (isBgp ? ' link(s) on the path' : ' link(s) in the tree')
          + (ecmp ? '  ·  ' + ecmp + ' ECMP' : '')));
        var lg = el('div', 'pnq-ov-keys');
        var k1 = el('span', 'pnq-ov-key');
        k1.appendChild(el('i', 'pnq-ov-sw ' + (isBgp ? 'sw-path' : 'sw-tree')));
        k1.appendChild(el('span', null, isBgp ? 'on path' : 'in tree'));
        var k2 = el('span', 'pnq-ov-key');
        k2.appendChild(el('i', 'pnq-ov-sw sw-ecmp')); k2.appendChild(el('span', null, 'ECMP'));
        var k3 = el('span', 'pnq-ov-key');
        k3.appendChild(el('i', 'pnq-ov-sw sw-dim')); k3.appendChild(el('span', null, isBgp ? 'off path' : 'off tree'));
        lg.appendChild(k1); lg.appendChild(k2); lg.appendChild(k3);
        box.appendChild(lg);
      }
    }
    if (res.unreachable && res.unreachable.length) {
      box.appendChild(el('div', 'pnq-ov-row pnq-ov-warn',
        'Unreachable from root: ' + res.unreachable.map(function (n) {
          return names[String(n)] || n; }).join(', ')));
    }
    (res.warnings || []).forEach(function (w) {
      box.appendChild(el('div', 'pnq-ov-row pnq-ov-warn', w));
    });
    applyPos(box);
    document.body.appendChild(box);
  }

  /* ---- paint ------------------------------------------------------------ */
  var STP_SHORT = { Root: 'R', Desg: 'D', Altn: 'A', Back: 'B', Mstr: 'M', Disa: '–' };
  function stpEndLabel(role, state, po) {
    if (!role && !state) return '';
    var s = STP_SHORT[role] || (role ? role.charAt(0) : '?');
    if (state && state !== 'FWD') s += '·' + state;   // R / D / A·BLK / A·LRN
    if (po) s += ' ' + po;                             // bundled -> show the Po
    return s;
  }
  function stpEndMod(role, state) {
    if (state === 'LIS' || state === 'LRN') return 'rl-trans';
    if (role === 'Root') return 'rl-root';
    if (role === 'Desg') return 'rl-desg';
    if (role === 'Altn') return 'rl-altn';
    if (role === 'Back') return 'rl-back';
    return 'rl-dim';
  }

  function paint(res) {
    clearOverlay(true);          // keep a live "watch convergence" re-poll running
    var isBgp = res.proto === 'bgp' || res.proto === 'route', isEigrp = res.proto === 'eigrp';
    var isMst = res.proto === 'mst', isStp = res.proto === 'stp' || isMst;
    if (isStp) {
      lastStpRes = res;     // names + addr2node, for the why-blocked popup
      var whyVlan = isMst ? res.instance : res.vlan;   // why-detail key
      // per-link colour by combined port state: both FWD = forwarding tree
      // (green); an Altn/Back/BLK end = the STP-blocked redundant link (red
      // dashed); an LIS/LRN end = still converging (amber, pulsing). Each end
      // wears a port-role badge (R/D/A/B [·STATE]) coloured by its role/state.
      // A blocked link also gets a clickable "?" badge -> why it blocked.
      (res.edges || []).forEach(function (e) {
        // map THIS link to its own connector (parallel links differ by interface)
        var conn = connForLink(e.a, e.b, e.a_if, e.b_if);
        if (!conn) return;
        var cls;
        if (e.transitioning) cls = 'pnq-ov-stp-trans';
        else if (e.forwarding) cls = 'pnq-ov-stp-fwd';
        else if (e.blocked) cls = 'pnq-ov-stp-blk';
        else cls = 'pnq-ov-dim';
        addClass(conn, cls);
        var aT = stpEndLabel(e.a_role, e.a_state, e.a_po);
        var bT = stpEndLabel(e.b_role, e.b_state, e.b_po);
        addEndLabels(conn, 'node' + e.a, aT, stpEndMod(e.a_role, e.a_state),
                        'node' + e.b, bT, stpEndMod(e.b_role, e.b_state));
        if (e.blocked) {
          // the blocked END is the Altn/Back/BLK side — query that node+port
          // (the Po when bundled, since STP detail is under the logical interface)
          var aBlk = (e.a_role === 'Altn' || e.a_role === 'Back' || e.a_state === 'BLK');
          var bn = aBlk ? { node: e.a, iface: e.a_po || e.a_if }
                        : { node: e.b, iface: e.b_po || e.b_if };
          addWhyBadge(conn, whyVlan, bn.node, bn.iface, isMst);
        }
      });
    } else if (isEigrp) {
      // forwarding (CEF/variance-aware) = solid purple; a feasible successor that
      // is only a backup = dashed purple; a neighbour that FAILS feasibility
      // (RD>=FD, only visible via all-links) = red dashed labelled "✗ RD≥FD";
      // off-path dimmed; nothing computed = discovered topology.
      // Each highlighted link is labelled role + composite metric: "S · <FD>" for
      // the successor, "FS · <TD>" for a feasible successor (active OR backup).
      var anyHot = (res.edges || []).some(function (e) {
        return e.forwarding || e.backup || e.infeasible; });
      (res.edges || []).forEach(function (e) {
        var conns = connsForPair(e.a, e.b);
        if (!conns.length) return;
        var cls, label = null, lblKind = 'eg';
        var m = (e.metric != null) ? ' · ' + e.metric : '';
        var role = e.role || (e.forwarding ? 'S' : 'FS');
        if (e.forwarding) { cls = 'pnq-ov-succ'; label = role + m; }      // solid = active
        else if (e.backup) { cls = 'pnq-ov-fs'; label = role + m; }       // dashed = backup
        else if (e.infeasible) {                                          // red = excluded
          cls = 'pnq-ov-nf'; lblKind = 'nf';
          label = (e.rd != null && e.fd != null) ? '✗ ' + e.rd + '≥' + e.fd : '✗';
        }
        else if (anyHot) { cls = 'pnq-ov-dim'; }
        else { cls = 'pnq-ov-topo'; }
        conns.forEach(function (c) {
          cls.split(' ').forEach(function (one) { if (one) addClass(c, one); });
          if (label != null && c === conns[0]) addCost(c, label, lblKind);
        });
      });
      // off-canvas exits (DMVPN tunnel / Null0 / off-canvas peer): badge the node
      // whose successor/FS leaves the canvas, and — when the next-hop IP resolves
      // to a canvas node (o.peer) with no real link between them — draw a dashed
      // virtual line to it so the tunnel path is visible, not just described.
      (res.offcanvas || []).forEach(function (o) {
        var nel = document.getElementById('node' + o.node);
        if (nel) { nel.classList.add('pnq-ov-offcanvas'); originEls.push(nel); }
        if (o.peer != null && !connsForPair(o.node, o.peer).length) {
          var pel = document.getElementById('node' + o.peer);
          if (pel) { pel.classList.add('pnq-ov-tunpeer'); originEls.push(pel); }
          addVline('node' + o.node, 'node' + o.peer);
        }
      });
    } else {
      var hot = isBgp ? 'in_path' : 'in_tree';
      var hotCls = isBgp ? 'pnq-ov-path' : 'pnq-ov-tree';
      var anyHot2 = (res.edges || []).some(function (e) { return e[hot]; });
      (res.edges || []).forEach(function (e) {
        var conns = connsForPair(e.a, e.b);
        if (!conns.length) return;
        var cls, label = null;
        if (e[hot]) {
          cls = e.ecmp ? hotCls + ' pnq-ov-ecmp' : hotCls;
          if (!isBgp) label = (e.dir === 'b2a') ? e.cost_ba : e.cost_ab;  // OSPF cost
        } else if (anyHot2) {
          cls = 'pnq-ov-dim';
        } else {
          cls = 'pnq-ov-topo';     // nothing computed: show the discovered topology
        }
        conns.forEach(function (c) {
          cls.split(' ').forEach(function (one) { if (one) addClass(c, one); });
          if (label != null && c === conns[0]) addCost(c, String(label));
        });
      });
    }
    rootEl = document.getElementById('node' + res.root);
    if (rootEl) rootEl.classList.add(isStp ? 'pnq-ov-stproot' : 'pnq-ov-root');
    if (isBgp || isEigrp) (res.origin || []).forEach(function (o) {
      var oel = document.getElementById('node' + o);
      if (oel) {
        oel.classList.add('pnq-ov-origin');
        if (isEigrp) oel.classList.add('pnq-ov-origin-eg');   // recolour purple
        originEls.push(oel);
      }
    });
    showLegend(res);
  }

  /* ---- run -------------------------------------------------------------- */
  function busyBox(msg) {
    var prev = document.getElementById('pnq-ov-legend');
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    var busy = el('div', 'pnq-ov-legend', msg); busy.id = 'pnq-ov-legend';
    applyPos(busy);
    document.body.appendChild(busy);
  }
  function postOverlay(payload, busyMsg) {
    if (busyMsg) busyBox(busyMsg);          // null => silent (watch re-poll)
    return fetch('/pnq-overlay.php', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }
  function withRoot(payload, rootId, altId) {
    payload.root_node_id = parseInt(rootId, 10);
    if (altId != null && altId !== '') payload.alt_root_node_id = parseInt(altId, 10);
    return payload;
  }
  function errInto(id, msg) { var b = document.getElementById(id); if (b) b.textContent = msg; }

  function runOspf(rootId, altId) {
    clearOverlay();
    lastRun = { proto: 'ospf', reqRoot: rootId, reqAlt: altId, prefix: null };
    postOverlay(withRoot({ action: 'ospf' }, rootId, altId), 'Computing OSPF SPF tree…')
      .then(function (res) {
        if (!res || (res.error && !res.edges)) return errInto('pnq-ov-legend', 'Overlay error: ' + ((res && res.error) || 'no data'));
        paint(res);
      }).catch(function (e) { errInto('pnq-ov-legend', 'Overlay request failed: ' + (e && e.message ? e.message : e)); });
  }
  window.pnqOverlayOSPF = runOspf;

  function runBgp(rootId, altId, prefix) {
    clearOverlay();
    lastRun = { proto: 'bgp', reqRoot: rootId, reqAlt: altId, prefix: prefix };
    postOverlay(withRoot({ action: 'bgp', prefix: prefix }, rootId, altId), 'Tracing BGP path for ' + prefix + '…')
      .then(function (res) {
        if (!res || (res.error && !res.edges)) return errInto('pnq-ov-legend', 'Overlay error: ' + ((res && res.error) || 'no data'));
        paint(res);
      }).catch(function (e) { errInto('pnq-ov-legend', 'Overlay request failed: ' + (e && e.message ? e.message : e)); });
  }
  window.pnqOverlayBGP = runBgp;

  function runEigrp(rootId, altId, prefix) {
    clearOverlay();
    lastRun = { proto: 'eigrp', reqRoot: rootId, reqAlt: altId, prefix: prefix };
    postOverlay(withRoot({ action: 'eigrp', prefix: prefix }, rootId, altId), 'Mapping EIGRP successor for ' + prefix + '…')
      .then(function (res) {
        if (!res || (res.error && !res.edges)) return errInto('pnq-ov-legend', 'Overlay error: ' + ((res && res.error) || 'no data'));
        paint(res);
      }).catch(function (e) { errInto('pnq-ov-legend', 'Overlay request failed: ' + (e && e.message ? e.message : e)); });
  }
  window.pnqOverlayEIGRP = runEigrp;

  // STP: map one VLAN's spanning tree. `silent` (watch re-poll) skips the busy
  // box + upfront clear so the live update doesn't flicker — paint() re-clears.
  function runStp(vlan, srcRoot, silent) {
    lastRun = { proto: 'stp', vlan: vlan, srcRoot: srcRoot, reqRoot: srcRoot };
    if (!silent) clearOverlay();
    postOverlay(withRoot({ action: 'stp', vlan: vlan }, srcRoot),
                silent ? null : 'Mapping spanning tree for VLAN ' + vlan + '…')
      .then(function (res) {
        if (!res || (res.error && !res.edges)) {
          if (!silent) errInto('pnq-ov-legend', 'Overlay error: ' + ((res && res.error) || 'no data'));
          return;
        }
        paint(res);
      }).catch(function (e) {
        if (!silent) errInto('pnq-ov-legend', 'Overlay request failed: ' + (e && e.message ? e.message : e));
      });
  }
  window.pnqOverlaySTP = runStp;

  function stpWatchTick() {
    if (!stpWatch) return;
    if (stpWatchN++ > 24) { stpWatch = false; return; }   // ~60s cap on console reads
    if (lastRun.proto === 'mst') runMst(lastRun.inst, lastRun.srcRoot, true);
    else runStp(lastRun.vlan, lastRun.srcRoot, true);
    stpWatchT = setTimeout(stpWatchTick, 2500);
  }
  function stopStpWatch() {
    stpWatch = false;
    if (stpWatchT) { clearTimeout(stpWatchT); stpWatchT = 0; }
  }
  function toggleStpWatch() {
    stpWatch = !stpWatch;
    if (stpWatch) { stpWatchN = 0; stpWatchTick(); }
    else if (stpWatchT) { clearTimeout(stpWatchT); stpWatchT = 0; }
  }

  /* BGP entry: fetch the root's prefixes, show a picker, trace the chosen one. */
  function pickBgp(rootId, altId) {
    clearOverlay();
    postOverlay(withRoot({ action: 'bgp-prefixes' }, rootId, altId), 'Reading BGP table…')
      .then(function (res) {
        var prev = document.getElementById('pnq-ov-legend');
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
        if (!res || res.error) return showError(res && res.error ? res.error : 'no BGP table', 'BGP Best-Path');
        var prefixes = res.prefixes || [];
        if (!prefixes.length) return showError('no BGP prefixes on ' + ((res.node && res.node.name) || 'this node'), 'BGP Best-Path');
        showPicker(res.node, prefixes, rootId, altId, 'bgp', 'BGP Best-Path');
      }).catch(function (e) { showError('BGP table request failed: ' + (e && e.message ? e.message : e), 'BGP Best-Path'); });
  }
  window.pnqOverlayBGPPick = pickBgp;

  /* Route Path entry (protocol-agnostic): trace the FIB forwarding path for a
     prefix regardless of which protocol installed it. Reuses the BGP forwarding
     trace + paint; the picker lists the root's whole routing table. */
  function runRoute(rootId, altId, prefix) {
    clearOverlay();
    lastRun = { proto: 'route', reqRoot: rootId, reqAlt: altId, prefix: prefix };
    postOverlay(withRoot({ action: 'route', prefix: prefix }, rootId, altId), 'Tracing route to ' + prefix + '…')
      .then(function (res) {
        if (!res || (res.error && !res.edges)) return errInto('pnq-ov-legend', 'Overlay error: ' + ((res && res.error) || 'no data'));
        paint(res);
      }).catch(function (e) { errInto('pnq-ov-legend', 'Overlay request failed: ' + (e && e.message ? e.message : e)); });
  }
  window.pnqOverlayRoute = runRoute;
  function pickRoute(rootId, altId) {
    clearOverlay();
    postOverlay(withRoot({ action: 'route-prefixes' }, rootId, altId), 'Reading routing table…')
      .then(function (res) {
        var prev = document.getElementById('pnq-ov-legend');
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
        if (!res || res.error) return showError(res && res.error ? res.error : 'no routing table', 'Route Path');
        var prefixes = res.prefixes || [];
        if (!prefixes.length) return showError('no routes on ' + ((res.node && res.node.name) || 'this node'), 'Route Path');
        showPicker(res.node, prefixes, rootId, altId, 'route', 'Route Path');
      }).catch(function (e) { showError('routing table request failed: ' + (e && e.message ? e.message : e), 'Route Path'); });
  }
  window.pnqOverlayRoutePick = pickRoute;

  /* EIGRP entry: fetch the root's topology prefixes, pick one, map successor/FS. */
  function pickEigrp(rootId, altId) {
    clearOverlay();
    postOverlay(withRoot({ action: 'eigrp-prefixes' }, rootId, altId), 'Reading EIGRP topology…')
      .then(function (res) {
        var prev = document.getElementById('pnq-ov-legend');
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
        if (!res || res.error) return showError(res && res.error ? res.error : 'no EIGRP topology', 'EIGRP Successor Map');
        var prefixes = res.prefixes || [];
        if (!prefixes.length) return showError('no EIGRP prefixes on ' + ((res.node && res.node.name) || 'this node'), 'EIGRP Successor Map');
        showPicker(res.node, prefixes, rootId, altId, 'eigrp', 'EIGRP Successor Map');
      }).catch(function (e) { showError('EIGRP topology request failed: ' + (e && e.message ? e.message : e), 'EIGRP Successor Map'); });
  }
  window.pnqOverlayEIGRPPick = pickEigrp;

  /* STP entry: read the source node's VLAN list, pick one, map its tree. */
  function pickStp(rootId, altId) {
    clearOverlay();
    postOverlay(withRoot({ action: 'stp-vlans' }, rootId, altId), 'Reading spanning-tree…')
      .then(function (res) {
        var prev = document.getElementById('pnq-ov-legend');
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
        if (!res || res.error) return showError(res && res.error ? res.error : 'no spanning-tree', 'STP Port Roles');
        var vlans = res.vlans || [];
        if (!vlans.length) return showError('no STP VLANs on ' + ((res.node && res.node.name) || 'this node') + ' — is it a switch running spanning-tree?', 'STP Port Roles');
        showPicker(res.node, vlans, rootId, altId, 'stp', 'STP Port Roles');
      }).catch(function (e) { showError('spanning-tree request failed: ' + (e && e.message ? e.message : e), 'STP Port Roles'); });
  }
  window.pnqOverlaySTPPick = pickStp;

  // MST: paint one instance's tree (same renderer as STP; result carries mst flag).
  function runMst(inst, srcRoot, silent) {
    lastRun = { proto: 'mst', inst: inst, srcRoot: srcRoot, reqRoot: srcRoot };
    if (!silent) clearOverlay();
    postOverlay(withRoot({ action: 'mst', mst_inst: inst }, srcRoot),
                silent ? null : 'Mapping MST instance ' + inst + '…')
      .then(function (res) {
        if (!res || (res.error && !res.edges)) {
          if (!silent) errInto('pnq-ov-legend', 'Overlay error: ' + ((res && res.error) || 'no data'));
          return;
        }
        paint(res);
      }).catch(function (e) {
        if (!silent) errInto('pnq-ov-legend', 'Overlay request failed: ' + (e && e.message ? e.message : e));
      });
  }
  window.pnqOverlayMST = runMst;

  /* MST entry: read the region's instances, pick one, paint it. */
  function pickMst(rootId, altId) {
    clearOverlay();
    postOverlay(withRoot({ action: 'mst-instances' }, rootId, altId), 'Reading MST instances…')
      .then(function (res) {
        var prev = document.getElementById('pnq-ov-legend');
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
        if (!res || res.error) return showError(res && res.error ? res.error : 'no MST config', 'STP (MST)');
        var insts = res.instances || [];
        if (!insts.length) return showError('no MST instances on ' + ((res.node && res.node.name) || 'this node')
          + ' — is it in MST mode (spanning-tree mode mst)?', 'STP (MST)');
        var items = insts.map(function (i) { return { inst: i.instance, vlans: i.vlans }; });
        showPicker({ name: res.region ? 'region ' + res.region : ((res.node && res.node.name) || 'root') },
                   items, rootId, altId, 'mst', 'STP (MST)');
      }).catch(function (e) { showError('MST request failed: ' + (e && e.message ? e.message : e), 'STP (MST)'); });
  }
  window.pnqOverlayMSTPick = pickMst;

  /* STP root comparison: gather every node's `show spanning-tree`, list each
     VLAN's root bridge; click a row to paint that VLAN. Reuses the VLAN picker
     (rows carry the root name as meta so PVST+ load-balancing is visible). */
  function pickStpRoots(rootId, altId) {
    clearOverlay();
    postOverlay(withRoot({ action: 'stp-roots' }, rootId, altId), 'Comparing STP roots across VLANs…')
      .then(function (res) {
        var prev = document.getElementById('pnq-ov-legend');
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
        if (!res || res.error) return showError(res && res.error ? res.error : 'no STP roots', 'STP / RSTP');
        var roots = res.roots || [], names = res.names || {};
        if (!roots.length) return showError('no STP VLANs found on these nodes', 'STP / RSTP');
        var items = roots.map(function (r) {
          return {
            vlan: r.vlan,
            root_name: (r.root != null) ? (names[String(r.root)] || ('node ' + r.root))
              : (r.root_addr || 'off-canvas'),
            prio: r.root_prio
          };
        });
        showPicker({ name: names[String(rootId)] || 'all nodes' }, items, rootId, altId, 'stp', 'STP / RSTP');
      }).catch(function (e) { showError('STP roots request failed: ' + (e && e.message ? e.message : e), 'STP / RSTP'); });
  }
  window.pnqOverlaySTPRoots = pickStpRoots;

  /* Why a port blocked: query the blocked port's detail, explain the BPDU that
     won. Designated-bridge address -> node name via the last STP run's addr2node. */
  function runStpWhy(vlan, node, iface, anchorEl, mst) {
    var box = openWhyBox();
    var body = document.getElementById('pnq-ov-whybody');
    body.appendChild(el('div', 'pnq-ov-row', 'Reading why ' + iface + ' is blocked…'));
    positionWhyBox(box, anchorEl);
    // silent fetch — must NOT use busyBox (it hijacks #pnq-ov-legend = the STP legend)
    postOverlay(withRoot({ action: 'stp-why', vlan: vlan, iface: iface, mst: mst ? 1 : 0 }, node), null)
      .then(function (res) {
        var b = document.getElementById('pnq-ov-whybody');
        if (!b) return;                       // user already closed it
        b.innerHTML = '';
        if (!res || res.error) {
          b.appendChild(el('div', 'pnq-ov-row pnq-ov-warn', (res && res.error) || 'no port detail'));
        } else {
          fillWhy(b, res, vlan, iface);
        }
        positionWhyBox(document.getElementById('pnq-ov-whybox'), anchorEl);  // re-anchor after fill
      })
      .catch(function (e) {
        var b = document.getElementById('pnq-ov-whybody');
        if (b) {
          b.innerHTML = '';
          b.appendChild(el('div', 'pnq-ov-row pnq-ov-warn',
            'request failed: ' + (e && e.message ? e.message : e)));
          positionWhyBox(document.getElementById('pnq-ov-whybox'), anchorEl);
        }
      });
  }

  /* Standalone popup (own id) — its Close removes ONLY this box; the painted
     overlay + its legend stay. Draggable (shares .pnq-ov-legend chrome). */
  function openWhyBox() {
    var prev = document.getElementById('pnq-ov-whybox');
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    var box = el('div', 'pnq-ov-legend'); box.id = 'pnq-ov-whybox';
    var head = el('div', 'pnq-ov-head');
    head.appendChild(el('span', 'pnq-ov-title', 'Why blocked?'));
    head.appendChild(el('button', 'pnq-ov-whyclose', 'Close'));
    box.appendChild(head);
    var body = el('div'); body.id = 'pnq-ov-whybody'; box.appendChild(body);
    document.body.appendChild(box);
    return box;
  }

  /* Anchor the popup just below the clicked "?" badge, flipping above / clamping
     so it stays fully on-screen. */
  function positionWhyBox(box, anchorEl) {
    if (!box || !anchorEl || !anchorEl.getBoundingClientRect) return;
    var pad = 10, gap = 8;
    var a = anchorEl.getBoundingClientRect();
    var bw = box.offsetWidth, bh = box.offsetHeight;
    var left = a.left + a.width / 2 - bw / 2;        // centred under the badge
    var top = a.bottom + gap;
    if (top + bh > window.innerHeight - pad) top = a.top - bh - gap;   // flip above
    left = Math.max(pad, Math.min(left, window.innerWidth - bw - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - bh - pad));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.right = 'auto';
  }

  function fillWhy(body, res, vlan, iface) {
    var w = res.why || {};
    var nodeName = (res.node && res.node.name) || 'switch';
    var names = (lastStpRes && lastStpRes.names) || {};
    var a2n = (lastStpRes && lastStpRes.addr2node) || {};
    if (!w.role) {
      body.appendChild(el('div', 'pnq-ov-row pnq-ov-warn',
        'Could not read port detail (console busy, or port not found).'));
      return;
    }
    body.appendChild(el('div', 'pnq-ov-row', nodeName + ' · ' + iface + ' (VLAN ' + vlan + ')'));
    body.appendChild(el('div', 'pnq-ov-row', 'Role: ' + w.role + (w.state ? ' (' + w.state + ')' : '')));
    if (w.port_cost != null) body.appendChild(el('div', 'pnq-ov-row', 'Port path cost: ' + w.port_cost));
    // resolve the two upstream (designated) bridges to switch names
    var nm = function (addr) { return addr ? (names[String(a2n[addr])] || addr) : null; };
    var thisUp = nm(w.des_bridge_addr), rootUp = nm(w.root_port_des_bridge_addr);
    if (w.root_port || thisUp) {
      var lbl = { cost: 'Decided by: root path cost', 'bridge-id': 'Decided by: designated bridge ID',
        'port-id': 'Decided by: designated port ID', backup: 'Backup port',
        'not-blocked': 'In the active topology' };
      body.appendChild(el('div', 'pnq-ov-row pnq-ov-offc-head', lbl[w.basis] || 'Why'));
      if (w.root_port) body.appendChild(el('div', 'pnq-ov-row pnq-ov-offc',
        'Root port (winner): ' + w.root_port + (rootUp ? ' → via ' + rootUp : '')
        + (w.root_port_cost != null ? ' · cost ' + w.root_port_cost : '')));
      if (thisUp) body.appendChild(el('div', 'pnq-ov-row pnq-ov-offc',
        'This link: ' + iface + ' → via ' + thisUp
        + (w.this_cost != null ? ' · cost ' + w.this_cost : '')));
    }
    // compose the explanation with resolved names (the winner's path via <rootUp>)
    var explain;
    if (w.basis === 'cost') {
      explain = 'This link reaches the root at cost ' + w.this_cost + (thisUp ? ' via ' + thisUp : '')
        + ', but the root port ' + w.root_port + ' reaches it cheaper (cost ' + w.root_port_cost + ')'
        + (rootUp ? ' via ' + rootUp : '') + ' — so this port is Alternate (blocked).';
    } else if (w.basis === 'bridge-id') {
      explain = 'Same root cost, but the root port ' + w.root_port + (rootUp ? ' reaches the root via ' + rootUp : '')
        + ' (lower bridge ID) while this link goes via ' + (thisUp || 'a higher-ID bridge')
        + ' — the higher bridge ID loses, so this port is Alternate (blocked).';
    } else if (w.basis === 'port-id') {
      explain = 'Both links reach the root via the same neighbour' + (rootUp ? ' (' + rootUp + ')' : '')
        + ' at equal cost — a tie. It is broken on the neighbour’s port ID: the root port '
        + w.root_port + ' got a lower sender port-id (' + w.root_port_des_port_id + ') than this port ('
        + w.des_port_id + '), so it won and this port is Alternate (blocked).';
    } else {
      explain = w.reason;
    }
    if (explain) body.appendChild(el('div', 'pnq-ov-row pnq-ov-why-explain', explain));
  }

  function showError(msg, title) {
    var box = el('div', 'pnq-ov-legend'); box.id = 'pnq-ov-legend';
    var head = el('div', 'pnq-ov-head');
    head.appendChild(el('span', 'pnq-ov-title', title || 'Topology Overlay'));
    var c = el('button', 'pnq-ov-clear', 'Clear'); head.appendChild(c);
    box.appendChild(head);
    box.appendChild(el('div', 'pnq-ov-row pnq-ov-warn', msg));
    applyPos(box);
    document.body.appendChild(box);
  }

  function showPicker(node, prefixes, rootId, altId, proto, title) {
    var pk = el('div', 'pnq-ov-legend'); pk.id = 'pnq-ov-picker';
    var head = el('div', 'pnq-ov-head');
    head.appendChild(el('span', 'pnq-ov-title', title || 'Topology Overlay'));
    var c = el('button', 'pnq-ov-clear', 'Clear'); head.appendChild(c);
    pk.appendChild(head);
    var isStpP = proto === 'stp', isMstP = proto === 'mst';
    pk.appendChild(el('div', 'pnq-ov-row', 'From ' + ((node && node.name) || 'root')
      + ' — pick ' + (isMstP ? 'an MST instance' : isStpP ? 'a VLAN' : 'a prefix') + ':'));
    var list = el('div', 'pnq-ov-plist');
    prefixes.forEach(function (p) {
      var row = el('button', 'pnq-ov-prow');
      if (isMstP) {
        row.setAttribute('data-inst', p.inst);
        row.appendChild(el('span', 'pnq-ov-pfx', 'MST ' + p.inst));
        if (p.vlans != null) row.appendChild(el('span', 'pnq-ov-pmeta', 'vlans ' + p.vlans));
      } else if (isStpP) {
        row.setAttribute('data-vlan', p.vlan);
        row.appendChild(el('span', 'pnq-ov-pfx', 'VLAN ' + p.vlan));
        if (p.root_name != null) {
          row.appendChild(el('span', 'pnq-ov-pmeta', 'root: ' + p.root_name
            + (p.prio != null ? ' · ' + p.prio : '')));
        }
      } else {
        row.setAttribute('data-prefix', p.prefix);
        row.appendChild(el('span', 'pnq-ov-pfx', p.prefix));
        row.appendChild(el('span', 'pnq-ov-pmeta',
          (p.paths != null ? p.paths + ' path' + (p.paths === 1 ? '' : 's') : '')
          + (p.multipath ? ' · mp' : '')
          + (p.fd != null ? ' · FD ' + p.fd : '')
          + (p.proto ? ' · ' + p.proto : '')            // Route Path: protocol
          + (p.via ? ' → ' + p.via : '')));              // Route Path: next-hop
      }
      list.appendChild(row);
    });
    pk.appendChild(list);
    pk.dataset.root = rootId; if (altId != null) pk.dataset.alt = altId;
    pk.dataset.proto = proto || 'bgp';
    applyPos(pk);
    document.body.appendChild(pk);
  }

  /* ---- wiring (delegated, CSP-safe) ------------------------------------- */
  function dropMenu() {
    var cm = document.getElementById('context-menu');
    if (cm && cm.parentNode) cm.parentNode.removeChild(cm);
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var a = e.target.closest('.action-overlay-ospf');
    if (a) { e.preventDefault(); dropMenu(); runOspf(a.getAttribute('data-root'), a.getAttribute('data-alt')); return; }
    var b = e.target.closest('.action-overlay-bgp');
    if (b) { e.preventDefault(); dropMenu(); pickBgp(b.getAttribute('data-root'), b.getAttribute('data-alt')); return; }
    var eg = e.target.closest('.action-overlay-eigrp');
    if (eg) { e.preventDefault(); dropMenu(); pickEigrp(eg.getAttribute('data-root'), eg.getAttribute('data-alt')); return; }
    var row = e.target.closest('.pnq-ov-prow');
    if (row) {
      e.preventDefault();
      var pk = document.getElementById('pnq-ov-picker');
      var rootId = pk ? pk.dataset.root : null, altId = pk ? pk.dataset.alt : null;
      var pproto = pk ? pk.dataset.proto : 'bgp';
      if (pk && pk.parentNode) pk.parentNode.removeChild(pk);
      if (pproto === 'mst') runMst(row.getAttribute('data-inst'), rootId);
      else if (pproto === 'stp') runStp(row.getAttribute('data-vlan'), rootId);
      else if (pproto === 'eigrp') runEigrp(rootId, altId, row.getAttribute('data-prefix'));
      else if (pproto === 'route') runRoute(rootId, altId, row.getAttribute('data-prefix'));
      else runBgp(rootId, altId, row.getAttribute('data-prefix'));
      return;
    }
    if (e.target.closest('#pnq-ov-watch')) { e.preventDefault(); toggleStpWatch(); return; }
    var why = e.target.closest('.pnq-ov-why');
    if (why) {
      e.preventDefault();
      runStpWhy(why.getAttribute('data-vlan'), why.getAttribute('data-node'),
                why.getAttribute('data-iface'), why, why.getAttribute('data-mst') === '1');
      return;
    }
    if (e.target.closest('.pnq-ov-whyclose')) {
      e.preventDefault();
      var wb = document.getElementById('pnq-ov-whybox');
      if (wb && wb.parentNode) wb.parentNode.removeChild(wb);   // close ONLY this popup
      return;
    }
    var sw = e.target.closest('.pnq-ov-swap');
    if (sw) {
      e.preventDefault();
      var other = sw.getAttribute('data-other'), cur = sw.getAttribute('data-cur');
      if (lastRun.proto === 'bgp') runBgp(other, cur, lastRun.prefix);
      else if (lastRun.proto === 'route') runRoute(other, cur, lastRun.prefix);
      else if (lastRun.proto === 'eigrp') runEigrp(other, cur, lastRun.prefix);
      else runOspf(other, cur);
      return;
    }
    if (e.target.closest('.pnq-ov-clear')) { e.preventDefault(); clearOverlay(); }
  });

  /* ---- panel dragging moved to pnetlab-lazy-overlays.js (always loaded) -----
   * The legend / picker / painter / rack-view / wifi panels all share
   * .pnq-ov-legend + .pnq-ov-head and ONE delegated drag handler. topology-overlay
   * is now lazy (Phase 3 incr 1), so that handler can't live here — protocol-painter
   * & rack-view panels would not drag until an OSPF/BGP overlay was first run. It now
   * lives in the launcher and records the remembered position in
   * window.pnqOvLegendPos (read by applyLegendPos above). */
})();
