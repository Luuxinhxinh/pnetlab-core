/**
 * pnetlab-wifi-painter.js — "Wi-Fi Painter" overlay for the emulated wireless plane
 * (Wireless AP / Wireless STA nodes, vwifi/mac80211_hwsim).
 *
 * Draws on the lab canvas:
 *   - an SSID badge over each Wireless AP, and
 *   - a signal-modulated packet link from each Wireless STA to the AP it links to
 *     (green uplink / blue downlink dots whose rate, size and brightness scale with
 *     RSSI), labelled SSID + RSSI (dBm) + SNR (dB), colour-graded by signal.
 *
 * Wireless nodes associate over the RF medium automatically just by being on the
 * canvas with a matching SSID (the broker auto-placer co-locates them) — no cable
 * needed. So this overlay is ALWAYS-ON by default and PASSIVE: it shows every
 * same-SSID client connected to its nearest AP and never disconnects a real node
 * for being far apart.
 *
 *   Distance roaming (opt-in, legend checkbox): when enabled, association follows
 *   canvas distance with a range cutoff AND is pushed into vwifi (pnq-wifi.php
 *   ?action=sync) so the REAL nodes roam/disconnect — drag a client out of range
 *   and it actually drops; between two same-SSID APs and it roams to the stronger.
 *   Disabling it resets the cell to the all-associated default.
 *
 * Self-contained: own sidebar entry, own SVG/label layer, own injected CSS.
 */
(function () {
  'use strict';

  /* RF model: RSSI(d)=TX-(PL0+10*n*log10(d_m)), d_m=px*M_PER_PX (>=1). SNR=RSSI-NOISE.
     With these defaults green(>=-60) reaches ~380px, good ~1400px, weak ~3000px. */
  var RF = { M_PER_PX: 0.07, TX_DBM: 20, PL0: 40, N: 2.8, NOISE_DBM: -95, SENS_DBM: -85 };

  /* Traveling-packet link tuning. Packets move at SPEED*sf px/s (sf = the per-quality
     signal factor), spaced ~SPACING px apart (clamped to CAP per direction). Stronger
     signal => faster, larger, brighter, denser dots. Uplink (client->AP) green, the
     lighter downlink (AP->client) blue, on opposite perpendicular lanes. */
  var PKT = { SPEED: 150, SPACING: 46, CAP: 16, UP: '#37d67a', DOWN: '#6fb4ff',
              SF: { good: 1, ok: 0.72, weak: 0.46, none: 0.28 } };

  var ROAM_KEY = 'pnq_wifi_roam', COV_KEY = 'pnq_wifi_cov', POS_KEY = 'pnq_wifi_pos',
      TRUTH_KEY = 'pnq_wifi_truth';
  var wifiDrag = null, dragWired = false;
  // Minimum on-screen top for the draggable pill, so it can never slide UNDER the
  // fixed top chrome (#pnetlab-quickbar) — the reported occlusion. ~56px clears the
  // top bar; paired with the explicit z-index on #pnq-wifi-legend.
  var TOP_CLAMP = 56;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var active = false, raf = 0, svg = null, layer = null, legend = null;
  var model = { aps: [], stas: [] };
  var syncTimer = 0, lastSyncKey = '', statusTimer = 0, truthTimer = 0;
  // Real per-node 802.11 state from pnq-wifi.php?truth=1 (broker wifi_truth over the
  // node console): id -> {associated, wpa_state, ssid, bssid, rssi, ...}. Lets the
  // painter show model-vs-actual DIVERGENCE (a wrong-PSK STA the model draws as
  // connected but that never associated) instead of a false healthy-green link.
  var truth = {};

  function isRoam() { return localStorage.getItem(ROAM_KEY) === '1'; }
  function isCoverage() { return localStorage.getItem(COV_KEY) !== '0'; }  // default on
  function isTruth() { return localStorage.getItem(TRUTH_KEY) !== '0'; }   // default on
  // Native canvas semantics: 2 = running, 3 = running while locked. Frozen (7)
  // is deliberately not considered live because its radio must not radiate.
  function isRunning(n) { return !!n && (n.status == 2 || n.status == 3); }
  // APs and STAs only share an RF medium when both rows identify the same one.
  // Fail closed for older/incomplete rows: crossing airduct and vwifi would draw
  // a link which cannot exist on either emulated transport.
  function sameMedium(a, b) {
    return !!a && !!b && !!a.medium && !!b.medium && a.medium === b.medium;
  }

  /* px radius at which RSSI hits a target dBm (inverse of the path-loss model). */
  function radiusPx(rssi) {
    return Math.pow(10, (RF.TX_DBM - RF.PL0 - rssi) / (10 * RF.N)) / RF.M_PER_PX;
  }

  /* Append one reusable radial gradient (strong core -> faded edge) to the svg. */
  function covGradient() {
    var defs = document.createElementNS(SVGNS, 'defs');
    var g = document.createElementNS(SVGNS, 'radialGradient');
    g.setAttribute('id', 'pnq-wifi-cov');
    // band offsets follow the quality thresholds as a fraction of the SENS radius
    var rMax = radiusPx(RF.SENS_DBM) || 1;
    var stops = [
      [0, '#37d67a', 0.42],
      [Math.min(99, 100 * radiusPx(-60) / rMax), '#37d67a', 0.34],
      [Math.min(99, 100 * radiusPx(-72) / rMax), '#d6c437', 0.26],
      [80, '#e08a37', 0.16],
      [100, '#e08a37', 0.0]
    ];
    stops.forEach(function (st) {
      var s = document.createElementNS(SVGNS, 'stop');
      s.setAttribute('offset', st[0] + '%');
      s.setAttribute('stop-color', st[1]);
      s.setAttribute('stop-opacity', st[2]);
      g.appendChild(s);
    });
    defs.appendChild(g);
    svg.appendChild(defs);
  }

  function $(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function injectCss() {
    if (document.getElementById('pnq-wifi-css')) return;
    var s = document.createElement('style');
    s.id = 'pnq-wifi-css';
    s.textContent =
      '.pnq-wifi-svg{position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:9000;overflow:visible}' +
      '.pnq-wifi-layer{position:fixed;left:0;top:0;width:0;height:0;z-index:9001;pointer-events:none}' +
      '.pnq-wifi-badge,.pnq-wifi-label{position:fixed;transform:translate(-50%,-50%);' +
      'font:600 11px/1.2 system-ui,Segoe UI,sans-serif;white-space:nowrap;padding:3px 7px;' +
      'border-radius:7px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.35)}' +
      '.pnq-wifi-badge{background:#0b3d2e;color:#7bffce;border:1px solid #1e7d5c}' +
      '.pnq-wifi-label{background:#10151c;color:#e7eef7;border:1px solid #2b3a4d;text-align:center}' +
      '.pnq-wifi-label .ssid{color:#9ecbff}' +
      '.pnq-wifi-label .dim{opacity:.6;margin:0 4px}' +
      '.pnq-wifi-l1{line-height:1.25}.pnq-wifi-l1 .bar{margin-right:3px}' +
      '.pnq-wifi-l2{font-size:10px;opacity:.85;line-height:1.2;margin-top:1px}' +
      '.pnq-wifi-q-good .bar{color:#37d67a}.pnq-wifi-q-ok .bar{color:#d6c437}' +
      '.pnq-wifi-q-weak .bar{color:#e08a37}.pnq-wifi-q-none .bar{color:#e05a5a}' +
      '.pnq-wifi-badge.detached{background:#3a2a10;color:#ffcf8a;border-color:#7d5c1e}' +
      '.pnq-wifi-badge.pnq-wifi-diverge{background:#3a1010;color:#ff9a9a;border-color:#7d1e1e}' +
      '.pnq-wifi-roam{display:flex;gap:6px;align-items:center;cursor:pointer}' +
      // Inline status text for the capture control (reused generic message style).
      '.pnq-wifi-connect-msg{margin-left:8px;font-size:11px;opacity:.9}' +
      // Dock the (minimal) Wi-Fi control as a compact pill at the BOTTOM-LEFT, in the
      // same band as the resources monitor (#pnq-sysmon, right:12px bottom:48px) and
      // clear of the quickbar (top) and the AI Builder panel (top-right). Overrides
      // only #pnq-wifi-legend — the shared .pnq-ov-legend keeps its position.
      // NB: no !important on left/top/right/bottom — the ID selector already beats
      // the shared .pnq-ov-legend class, and keeping them !important-free lets the
      // drag handler (and a saved position) override them via inline styles.
      // z-index EXPLICIT (was inherited from .pnq-ov-legend=100050 and could sit UNDER
      // the top chrome/quickbar when dragged to the top). 100060 = one tier above the
      // overlay-legend base + the quickbar modal band (100039–100041), and safely BELOW
      // the island modal portal (100100) and toasts (100200) so it never covers a real
      // modal. Paired with the drag/restore min-top clamp below the top chrome.
      '#pnq-wifi-legend{right:auto;top:auto;left:12px;bottom:48px;min-width:0;z-index:100060;' +
      'max-width:none;max-height:none !important;display:flex !important;' +
      'flex-direction:row;align-items:center;gap:14px;padding:7px 12px;overflow:visible}' +
      '#pnq-wifi-legend .pnq-wifi-tag{font-weight:700;color:#9ecbff;font-size:12px;cursor:move;user-select:none}' +
      '#pnq-wifi-legend .pnq-wifi-roam{gap:5px;font-size:12px;white-space:nowrap;margin:0}' +
      '#pnq-wifi-legend .pnq-ov-clear{margin:0;padding:0 6px;font-size:15px;line-height:1}';
    document.head.appendChild(s);
  }

  /* viewport-centre (SCREEN coords) of a canvas node element.

     Two canvases, one screen-space contract: the painter's SVG/badge layers are
     position:fixed, so nodeCenter must return client (viewport) coordinates.

     • Flow island (b1 default): the visual node is a Svelte Flow node rendered
       inside #pnq-island-canvas-flow as `.svelte-flow__node[data-id="<id>"]` — the
       data-id is the raw device id, exactly the id pnq-wifi.php hands us (see
       map-store.js nodesFromStore: device nodes keep their bare id; only
       decorations get a 'deco_' prefix and networks a 'net_' prefix, neither of
       which are wireless nodes). Its getBoundingClientRect() is already pan/zoom-
       correct (the flow viewport transform is baked into layout), and because we
       query per-frame the badges track live during pan/zoom and survive an island
       reseed (no element is cached). The legacy jsPlumb #node<id> element is hidden
       under the island, so we must NOT read it while the island is mounted.
     • Classic canvas (?canvas=classic): fall back to the legacy jsPlumb DOM
       ('node'+id, as the OSPF/BGP overlays use).

     We try the island first (present == flow is live) and fall back to legacy, so
     the same painter runs unchanged on both canvases. */
  function islandNode(id) {
    var isl = document.getElementById('pnq-island-canvas-flow');
    if (!isl) return null;
    // CSS.escape isn't guaranteed in every sloppy-mode context; node ids are
    // digits so a plain attribute match is safe. Guard anyway.
    var sel = '.svelte-flow__node[data-id="' + String(id).replace(/"/g, '\\"') + '"]';
    return isl.querySelector(sel);
  }
  // Cached lab-space half-node-size, calibrated from any node that IS in the DOM
  // (screen half-size / current zoom). Lets the DOM-free fallback place a culled
  // node's CENTER (not its top-left corner) so a coverage circle doesn't jump when a
  // node scrolls off-screen. Defaults to a device-node-ish 24 lab units until seen.
  var labHalf = 24;

  function modelNode(id) {
    var all = model.aps.concat(model.stas), i;
    for (i = 0; i < all.length; i++) if (String(all[i].id) === String(id)) return all[i];
    return null;
  }

  /* Screen-space centre of a node. DOM first (exact, and pan/zoom-correct for a
     VISIBLE flow node). Under canvas virtualization (onlyRenderVisibleElements) an
     off-screen flow node has NO DOM element, so nodeCenter would return null and its
     coverage circle / association line / roaming candidacy would silently vanish even
     where they overlap the viewport. Fall back to the island's lab->screen transform
     (window.__pnqFlowXform.labToScreen) applied to the node's canvas left/top (from
     pnq-wifi.php, so DOM-free), which is exactly how the flow places the node. */
  function nodeCenter(id) {
    var n = islandNode(id) ||
            document.getElementById('node' + id) ||
            document.getElementById(String(id));
    if (n) {
      var r = n.getBoundingClientRect();
      if (r.width || r.height) {
        // Opportunistically calibrate labHalf from this visible node + the xform zoom.
        var xf0 = (typeof window !== 'undefined') ? window.__pnqFlowXform : null;
        if (xf0 && xf0.active) {
          try {
            var o = xf0.labToScreen(0, 0), u = xf0.labToScreen(100, 0);
            var zoom = (u.x - o.x) / 100;
            if (zoom > 0.0001) labHalf = (r.width / 2) / zoom;
          } catch (e) {}
        }
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    // DOM-free fallback for a culled node.
    var xf = (typeof window !== 'undefined') ? window.__pnqFlowXform : null;
    if (xf && xf.active) {
      var m = modelNode(id);
      if (m && typeof m.left === 'number' && typeof m.top === 'number') {
        try {
          var c = xf.labToScreen(m.left + labHalf, m.top + labHalf);
          if (c && isFinite(c.x) && isFinite(c.y)) return { x: c.x, y: c.y };
        } catch (e) {}
      }
    }
    return null;
  }

  function rf(dpx) {
    var dm = Math.max(1, dpx * RF.M_PER_PX);
    var rssi = RF.TX_DBM - (RF.PL0 + 10 * RF.N * Math.log10(dm));
    return { rssi: Math.round(rssi), snr: Math.max(0, Math.round(rssi - RF.NOISE_DBM)),
             inRange: rssi >= RF.SENS_DBM };
  }

  function quality(rssi) {
    if (rssi >= -60) return 'good';
    if (rssi >= -72) return 'ok';
    if (rssi >= -85) return 'weak';
    return 'none';
  }

  /* For each STA pick the matching-SSID AP with the best RSSI. Passive (default):
     nearest matching AP regardless of range (a same-SSID client is always shown
     connected). Roaming: only in-range APs (out of range => searching). */
  function associate() {
    var roam = isRoam();
    var links = [];
    model.stas.forEach(function (sta) {
      // a stopped/not-running client has no radio on the medium -> draw nothing
      // (its link disappears the moment it shuts down).
      if (!isRunning(sta)) return;
      var sc = nodeCenter(sta.id);
      if (!sc) return;
      var best = null;
      model.aps.forEach(function (ap) {
        // only a RUNNING AP beacons — a stopped AP can't carry an association.
        if (!isRunning(ap)) return;
        if (!sameMedium(sta, ap)) return;
        // empty SSID (GUI/NetworkManager client) = associate to the nearest AP
        // regardless of SSID; otherwise the AP must broadcast the STA's SSID.
        if (sta.ssid && (ap.ssids || [ap.ssid]).indexOf(sta.ssid) < 0) return;
        var ac = nodeCenter(ap.id);
        if (!ac) return;
        var dx = ac.x - sc.x, dy = ac.y - sc.y;
        var s = rf(Math.sqrt(dx * dx + dy * dy));
        if (roam && !s.inRange) return;
        if (!best || s.rssi > best.s.rssi) best = { ap: ap, ac: ac, s: s };
      });
      links.push({ sta: sta, sc: sc, assoc: best });
    });
    return links;
  }

  /* Signal-modulated traveling packets for ONE connected link a(STA)->b(AP).
     Positions are computed from performance.now() each frame, so the motion is
     wall-clock driven and survives the per-frame SVG rebuild (a freshly created
     element can't carry a CSS/SMIL animation forward). ox/oy = unit perpendicular,
     len = link length in px, q = signal quality bucket. */
  function drawPackets(a, b, ox, oy, len, q) {
    var sf = PKT.SF[q] || 0.3;
    var v = PKT.SPEED * sf;                  // px/s
    var cps = v / len;                       // link traversals per second
    var t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    var r = 2.2 + sf * 1.7;                  // dot radius scales with signal
    var op = 0.35 + sf * 0.55;               // dot opacity scales with signal
    function lane(n, color, dir, perp) {
      for (var i = 0; i < n; i++) {
        var p = ((t * cps + i / n) % 1 + 1) % 1;       // 0..1 along client->AP
        var f = dir > 0 ? p : 1 - p;                   // travel direction
        var x = a.x + (b.x - a.x) * f + ox * perp;
        var y = a.y + (b.y - a.y) * f + oy * perp;
        var fade = 0.4 + 0.6 * Math.sin(p * Math.PI);  // fade in/out at the endpoints
        var c = document.createElementNS(SVGNS, 'circle');
        c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', r);
        c.setAttribute('fill', color);
        c.setAttribute('fill-opacity', (op * fade).toFixed(3));
        svg.appendChild(c);
      }
    }
    var nUp = Math.max(2, Math.min(PKT.CAP, Math.round(len / PKT.SPACING)));
    var nDown = Math.max(1, Math.round(nUp / 2));      // lighter return stream
    lane(nUp, PKT.UP, 1, 3);        // uplink  client -> AP  (+lane)
    lane(nDown, PKT.DOWN, -1, -3);  // downlink AP -> client (-lane)
  }

  function draw() {
    if (!svg || !layer) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    while (layer.firstChild) layer.removeChild(layer.firstChild);

    // coverage heatmap: a signal-graded glow around each AP (drawn first = behind)
    if (isCoverage() && model.aps.length) {
      covGradient();
      var rMax = radiusPx(RF.SENS_DBM);
      model.aps.forEach(function (ap) {
        if (!isRunning(ap)) return;          // only running APs radiate coverage
        var c = nodeCenter(ap.id);
        if (!c) return;
        var circ = document.createElementNS(SVGNS, 'circle');
        circ.setAttribute('cx', c.x); circ.setAttribute('cy', c.y);
        circ.setAttribute('r', rMax);
        circ.setAttribute('fill', 'url(#pnq-wifi-cov)');
        svg.appendChild(circ);
      });
    }

    model.aps.forEach(function (ap) {
      var c = nodeCenter(ap.id);
      if (!c) return;
      // One badge per SSID this AP broadcasts (multi-BSS), stacked upward.
      var list = ap.ssids || [ap.ssid];
      var off = !isRunning(ap);
      list.forEach(function (sd, i) {
        var b = $('div', 'pnq-wifi-badge', '📡 ' + esc(sd) + (off ? ' (off)' : ''));
        if (off) b.style.opacity = '0.4';
        b.style.left = c.x + 'px';
        b.style.top = (c.y - 38 - i * 20) + 'px';
        layer.appendChild(b);
      });
    });

    associate().forEach(function (lk) {
      if (!lk.assoc) {
        var nb = $('div', 'pnq-wifi-badge detached', '⚠ searching “' + esc(lk.sta.ssid) + '”');
        nb.style.left = lk.sc.x + 'px';
        nb.style.top = (lk.sc.y - 38) + 'px';
        layer.appendChild(nb);
        return;
      }
      var a = lk.sc, b = lk.assoc.ac, s = lk.assoc.s, q = quality(s.rssi);
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ox = -dy / len, oy = dx / len;    // unit perpendicular

      // Truth overlay: the model says this STA is connected. Cross-check the REAL
      // console state (broker wifi_truth). Three cases:
      //   diverge  — real state present AND not associated (e.g. wrong PSK: the model
      //              draws a healthy link but the 4-way never completed) -> RED, no
      //              packet stream, a "not associated" badge. This is the whole point:
      //              stop lying about a link that isn't really there.
      //   verified — real state present AND associated -> keep the link, but show the
      //              REAL RSSI (from the guest) instead of the modelled one.
      //   unknown  — no real state yet (truth off, node just booted, console busy) ->
      //              fall back to the modelled drawing unchanged.
      var real = truth[lk.sta.id];
      var diverge = real && real.associated === false;
      var verified = real && real.associated === true;

      if (diverge) {
        var rline = document.createElementNS(SVGNS, 'line');
        rline.setAttribute('x1', a.x); rline.setAttribute('y1', a.y);
        rline.setAttribute('x2', b.x); rline.setAttribute('y2', b.y);
        rline.setAttribute('stroke', '#e05a5a'); rline.setAttribute('stroke-width', '1.8');
        rline.setAttribute('stroke-opacity', '0.7'); rline.setAttribute('stroke-dasharray', '5 5');
        svg.appendChild(rline);
        var st = (real.wpa_state && real.wpa_state !== '') ? real.wpa_state : 'not associated';
        var db = $('div', 'pnq-wifi-badge detached pnq-wifi-diverge',
          '⛔ not associated <span style="opacity:.7">(' + esc(st) + ')</span>');
        db.style.left = ((a.x + b.x) / 2) + 'px';
        db.style.top = ((a.y + b.y) / 2) + 'px';
        layer.appendChild(db);
        return;
      }

      // Use the real RSSI when verified (falls back to the modelled value otherwise).
      var rssi = (verified && typeof real.rssi === 'number') ? real.rssi : s.rssi;
      var snr = Math.max(0, Math.round(rssi - RF.NOISE_DBM));
      q = quality(rssi);
      var col = { good: '#37d67a', ok: '#d6c437', weak: '#e08a37', none: '#e05a5a' }[q];
      // A faint base line tinted by signal quality keeps the link visible between
      // packets; the signal-modulated packet streams (drawn over it) carry the
      // direction (green up / blue down) and the data-rate feel.
      var base = document.createElementNS(SVGNS, 'line');
      base.setAttribute('x1', a.x); base.setAttribute('y1', a.y);
      base.setAttribute('x2', b.x); base.setAttribute('y2', b.y);
      base.setAttribute('stroke', col); base.setAttribute('stroke-width', '1.6');
      base.setAttribute('stroke-opacity', '0.28'); base.setAttribute('stroke-linecap', 'round');
      svg.appendChild(base);
      drawPackets(a, b, ox, oy, len, q);

      var lblSsid = lk.sta.ssid || (lk.assoc.ap.ssids && lk.assoc.ap.ssids[0]) || lk.assoc.ap.ssid || '';
      // Two stacked rows: (1) signal bars (count reflects quality) + SSID, (2) RSSI +
      // SNR. A small ✓ marks an RSSI corroborated by the real console read.
      var bars = { good: '▮▮▮▮', ok: '▮▮▮', weak: '▮▮', none: '▮' }[q] || '▮';
      var mark = verified ? ' <span style="color:#7bffce" title="verified on the node">✓</span>' : '';
      var lab = $('div', 'pnq-wifi-label pnq-wifi-q-' + q,
        '<div class="pnq-wifi-l1"><span class="bar">' + bars + '</span> <span class="ssid">' + esc(lblSsid) + '</span>' + mark + '</div>' +
        '<div class="pnq-wifi-l2">' + rssi + ' dBm <span class="dim">|</span> SNR ' + snr + ' dB</div>');
      lab.style.left = ((a.x + b.x) / 2) + 'px';
      lab.style.top = ((a.y + b.y) / 2) + 'px';
      layer.appendChild(lab);
    });
  }

  function esc(t) { return String(t).replace(/[<>&"]/g, function (c) {
    return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }

  function tick() { draw(); raf = requestAnimationFrame(tick); }

  /* Realise graded RF in vwifi — only in roaming mode; passive mode never touches
     the real nodes (they stay auto-associated via the broker auto-placer). The
     server (pnq-wifi.php action=sync) now reads each node's REAL canvas position from
     the .unl and pushes it (px->metres) into vwifi + enables loss, so the payload is
     just the trigger — no client-computed association. Re-posted on a slow cadence so
     a node drag (persisted to the .unl by the island) re-grades within a few seconds,
     exactly like airduct-pos-sync. DOM-free: correct for off-screen nodes too. */
  function syncToVwifi() {
    if (!isRoam()) return;
    fetch('/pnq-wifi.php', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sync' })
    }).catch(function () {});
  }

  function resetCell() {
    fetch('/pnq-wifi.php', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset' })
    }).catch(function () {});
  }

  function setRoam(on) {
    localStorage.setItem(ROAM_KEY, on ? '1' : '0');
    lastSyncKey = '';
    if (on) syncToVwifi();   // realise current geometry in vwifi
    else resetCell();        // back to all-associated default
  }

  // Restore a previously dragged position (clamped to the viewport), switching the
  // pill from its bottom-left default to explicit left/top.
  function restorePos(box) {
    var p;
    try { p = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { p = null; }
    if (!p || typeof p.left !== 'number' || typeof p.top !== 'number') return;
    var x = Math.max(0, Math.min(window.innerWidth - 60, p.left));
    var y = Math.max(TOP_CLAMP, Math.min(window.innerHeight - 24, p.top));
    box.style.left = x + 'px'; box.style.top = y + 'px';
    box.style.right = 'auto'; box.style.bottom = 'auto';
  }

  // The document-level move/up listeners are wired ONCE and act on the current
  // `legend` box; the per-build handle just arms a drag.
  function wireDrag() {
    if (dragWired) return; dragWired = true;
    document.addEventListener('mousemove', function (e) {
      if (!wifiDrag || !legend) return;
      e.preventDefault();
      var x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - wifiDrag.dx));
      var y = Math.max(TOP_CLAMP, Math.min(window.innerHeight - 24, e.clientY - wifiDrag.dy));
      legend.style.left = x + 'px'; legend.style.top = y + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!wifiDrag) return;
      wifiDrag = null;
      document.body.style.userSelect = '';
      if (!legend) return;
      try {
        var r = legend.getBoundingClientRect();
        localStorage.setItem(POS_KEY, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
      } catch (e) {}
    });
  }
  function armDrag(box, handle) {
    handle.title = 'Drag to move';
    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var r = box.getBoundingClientRect();
      box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      box.style.right = 'auto'; box.style.bottom = 'auto';
      wifiDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      document.body.style.userSelect = 'none';
    });
  }

  // Minimal Wi-Fi control: just the two toggles, docked at the bottom next to the
  // resources monitor (#pnq-sysmon, right:12px bottom:48px). Draggable by the
  // "Wi-Fi" tag; position is remembered. The verbose legend (counts, signal colour
  // key, station-connect form) was removed per request.
  function makeLegend() {
    var box = $('div', 'pnq-ov-legend'); box.id = 'pnq-wifi-legend';
    var tag = $('span', 'pnq-wifi-tag', 'Wi-Fi');
    box.appendChild(tag);

    // Coverage heatmap toggle
    var clbl = $('label', 'pnq-wifi-roam');
    clbl.title = 'AP coverage heatmap — a signal-graded glow around each AP';
    var ccb = document.createElement('input'); ccb.type = 'checkbox'; ccb.checked = isCoverage();
    ccb.addEventListener('change', function () {
      localStorage.setItem(COV_KEY, ccb.checked ? '1' : '0');
    });
    clbl.appendChild(ccb);
    clbl.appendChild($('span', null, 'Coverage'));
    box.appendChild(clbl);

    // Distance-roaming toggle
    var lbl = $('label', 'pnq-wifi-roam');
    lbl.title = 'Distance roaming (RF) — far clients really disconnect / roam to the '
      + 'stronger AP; also enables airduct Tier-1 distance-loss for this lab (cVAP/'
      + 'cwificlient frames drop beyond the drawn coverage)';
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = isRoam();
    cb.addEventListener('change', function () { setRoam(cb.checked); });
    lbl.appendChild(cb);
    lbl.appendChild($('span', null, 'Distance roaming (RF)'));
    box.appendChild(lbl);

    // Truth overlay toggle: cross-check the modelled association against the node's
    // REAL 802.11 state and flag divergence (wrong-PSK "connected" links go red).
    var tlbl = $('label', 'pnq-wifi-roam');
    tlbl.title = 'Verify associations on the nodes (console read) — a client the model '
      + 'shows connected but that never really associated (e.g. wrong passphrase) turns red';
    var tcb = document.createElement('input'); tcb.type = 'checkbox'; tcb.checked = isTruth();
    tcb.addEventListener('change', function () {
      localStorage.setItem(TRUTH_KEY, tcb.checked ? '1' : '0');
      if (tcb.checked) refreshTruth(); else truth = {};
    });
    tlbl.appendChild(tcb);
    tlbl.appendChild($('span', null, 'Verify (real)'));
    box.appendChild(tlbl);

    // 802.11 capture: arm the per-session pcap tee, then open it in the web Wireshark
    // (pnet-capture-web, file mode). Works for whichever medium(s) the lab uses.
    var capLbl = $('label', 'pnq-wifi-roam');
    capLbl.title = 'Capture 802.11 frames on the emulated medium to a pcap';
    var capCb = document.createElement('input'); capCb.type = 'checkbox';
    var capMsg = $('span', 'pnq-wifi-connect-msg', '');
    capCb.addEventListener('change', function () { armCapture(capCb.checked ? 'start' : 'stop', capMsg); });
    capLbl.appendChild(capCb);
    capLbl.appendChild($('span', null, 'Capture'));
    box.appendChild(capLbl);
    var openWs = $('button', 'pnq-ov-clear', 'Wireshark ⇱');
    openWs.title = 'Open the captured 802.11 frames in Wireshark (web)';
    openWs.addEventListener('click', function () { openWifiWireshark(capMsg); });
    box.appendChild(openWs);
    box.appendChild(capMsg);

    // small dismiss affordance (the sidebar entry re-opens it)
    var close = $('button', 'pnq-ov-clear', '×');
    close.title = 'Hide Wi-Fi Painter';
    close.addEventListener('click', stop);
    box.appendChild(close);

    document.body.appendChild(box);
    legend = box;
    restorePos(box);
    wireDrag();
    armDrag(box, tag);
  }

  // Rebuild model.aps/stas from a pnq-wifi.php response. Called at start AND on a
  // poll so node STATUS (running/stopped) stays live — the draw loop reads only
  // positions from the DOM, so without this refresh a stopped node kept its cached
  // status=2 and its link lingered after shutdown.
  function applyNodes(res) {
    var ns = (res && res.nodes) ? res.nodes : [];
    model.aps = ns.filter(function (n) { return n.role === 'ap'; });
    model.stas = ns.filter(function (n) { return n.role === 'sta'; });
    // VLAN-trunk multi-SSID: an AP may broadcast several SSIDs. Normalise to a
    // .ssids array (fall back to the single .ssid).
    model.aps.forEach(function (ap) { if (!ap.ssids || !ap.ssids.length) ap.ssids = [ap.ssid]; });
    // Emulated media present in this lab (airduct = cvap/cwificlient, vwifi =
    // wifiap/wifista) — drives the 802.11 capture control (each medium tees its own
    // pcap and opens its own web-Wireshark viewer).
    var seen = {}; model.mediums = [];
    ns.forEach(function (n) { var m = n.medium || 'airduct'; if (!seen[m]) { seen[m] = 1; model.mediums.push(m); } });
  }
  function refreshNodes() {
    fetch('/pnq-wifi.php', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(applyNodes)
      .catch(function () {});
  }

  /* ── 802.11 capture control ─────────────────────────────────────────────────
     Arm/disarm the opt-in per-session pcap tee (airduct = airhandler _flood tee;
     vwifi = vwifi-server spy tee) via pnq-wifi.php action=capture, and open the
     produced pcap in the SAME pnet-capture-web viewer the live node captures use
     (file mode) via /api/labs/session/wireshark/wifiview -> console.html?capture=1. */
  function armCapture(op, msgEl) {
    var media = (model.mediums && model.mediums.length) ? model.mediums : ['airduct'];
    if (msgEl) { msgEl.style.color = '#cfe'; msgEl.textContent = (op === 'start' ? 'Arming…' : 'Stopping…'); }
    return Promise.all(media.map(function (m) {
      return fetch('/pnq-wifi.php', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'capture', op: op, medium: m })
      }).then(function (r) { return r.json(); }).catch(function () { return null; });
    })).then(function () {
      if (msgEl) { msgEl.style.color = '#7bffce';
        msgEl.textContent = (op === 'start' ? 'Capturing — traffic will accrue.' : 'Capture stopped.'); }
    });
  }

  function openCaptureConsole(node, iface, name) {
    var url = '/console/console.html?capture=1&node=' + encodeURIComponent(node)
      + '&iface=' + encodeURIComponent(iface) + '&name=' + encodeURIComponent(name || '802.11');
    if (typeof window.pnqOpenConsoleWindow === 'function')
      window.pnqOpenConsoleWindow(url, 'wifi-cap-' + node, name || 'Wi-Fi capture',
        { width: '988px', height: '676px' });
    else
      window.open(url, 'pnet-wifi-cap-' + node);
  }

  function openWifiWireshark(msgEl) {
    var media = (model.mediums && model.mediums.length) ? model.mediums : ['airduct'];
    if (msgEl) { msgEl.style.color = '#cfe'; msgEl.textContent = 'Opening Wireshark…'; }
    var opened = 0;
    return media.reduce(function (p, m) {
      return p.then(function () {
        return fetch('/api/labs/session/wireshark/wifiview', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ medium: m })
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (res && res.status === 'success' && res.message) {
            openCaptureConsole(res.message.node, res.message.iface, res.message.name);
            opened++;
          } else if (msgEl && res && res.message) {
            msgEl.style.color = '#e0a0a0';
            msgEl.textContent = (typeof res.message === 'string') ? res.message : (res.message.message || 'No capture yet');
          }
        }).catch(function () {});
      });
    }, Promise.resolve()).then(function () {
      if (msgEl && opened) { msgEl.style.color = '#7bffce'; msgEl.textContent = 'Opened in Wireshark (web).'; }
      else if (msgEl && !opened && msgEl.textContent === 'Opening Wireshark…') {
        msgEl.style.color = '#e0a0a0'; msgEl.textContent = 'No frames captured yet — arm capture first.';
      }
    });
  }

  /* Slow poll (separate from the 3s status poll): pull the REAL association state
     of each running node over its console (?truth=1 -> broker wifi_truth) and cache
     it by id. A console read is heavier and single-client, so this runs less often
     and never blocks the draw loop. Skipped when the truth overlay is toggled off. */
  function refreshTruth() {
    if (!isTruth()) { truth = {}; return; }
    fetch('/pnq-wifi.php?truth=1', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var next = {}, ns = (res && res.nodes) ? res.nodes : [];
        ns.forEach(function (n) { if (n.real) next[n.id] = n.real; });
        truth = next;
      })
      .catch(function () {});
  }

  function start(silent) {
    injectCss();
    fetch('/pnq-wifi.php', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        applyNodes(res);
        if (!model.aps.length && !model.stas.length) {
          if (!silent && typeof addMessage === 'function')
            addMessage('warning', 'No Wireless AP / STA nodes in this lab');
          active = false;
          return;
        }
        svg = document.createElementNS(SVGNS, 'svg');
        svg.setAttribute('class', 'pnq-wifi-svg'); svg.id = 'pnq-wifi-svg';
        document.body.appendChild(svg);
        layer = $('div', 'pnq-wifi-layer'); layer.id = 'pnq-wifi-layer';
        document.body.appendChild(layer);
        makeLegend();
        tick();
        lastSyncKey = '';
        syncToVwifi();                               // no-op unless roaming is on
        syncTimer = setInterval(syncToVwifi, 3000);  // slow re-grade to pick up drags
        statusTimer = setInterval(refreshNodes, 3000);  // live status (stop/start)
        refreshTruth();                                 // real association (console read)
        truthTimer = setInterval(refreshTruth, 8000);   // slower: console is single-client
      })
      .catch(function () {
        if (!silent && typeof addMessage === 'function')
          addMessage('danger', 'Wi-Fi Painter: could not load wireless nodes');
        active = false;
      });
  }

  function stop() {
    active = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (syncTimer) { clearInterval(syncTimer); syncTimer = 0; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = 0; }
    if (truthTimer) { clearInterval(truthTimer); truthTimer = 0; }
    if (isRoam()) resetCell();   // don't leave clients stranded where the model put them
    [svg, layer, legend].forEach(function (e) { if (e && e.parentNode) e.parentNode.removeChild(e); });
    svg = layer = legend = null;
  }

  /* sidebar toggle */
  window.pnqOverlayWifi = function () {
    if (active) { stop(); return; }
    active = true; start(false);
  };

  /* Test seam — lets the gate assert the flow-DOM lookup is correct even on a
     no-wireless smoke lab (where the painter otherwise has nothing to draw). The
     gate compares __pnqWifiTest.nodeCenter(id) against the island node's own
     getBoundingClientRect() for a handful of REAL node ids. Zero runtime cost. */
  window.__pnqWifiTest = { nodeCenter: nodeCenter, islandNode: islandNode, isRunning: isRunning };

  /* ── sidebar entry + always-on auto-start ────────────────────────────────── */
  // Batch 2 (cleanup wave): the Wi-Fi painter now runs NATIVELY on the flow island.
  // nodeCenter() reads the Svelte Flow node DOM (screen coords, pan/zoom-correct),
  // so the position:fixed badge/packet layers track the flow canvas exactly as they
  // do the classic jsPlumb canvas. The always-on auto-start therefore fires on BOTH
  // canvases now; nodeCenter's per-frame island query self-heals the mount race (it
  // returns null until the flow node exists and the redraw loop picks it up on the
  // next frame). No canvas-mode gate needed anymore.
  function autoStart() {
    if (active) return;
    active = true; start(true);   // silent: no message on non-wireless labs
  }

  function inject() {
    if (document.getElementById('pnq-wifipainter')) return true;
    var ul = document.querySelector('#lab-sidebar ul');
    if (!ul) return false;
    var li = $('li');
    li.id = 'pnq-wifipainter';
    li.innerHTML = '<a href="javascript:void(0)" title="Show SSIDs, associations &amp; signal on the canvas">' +
      '<i class="fa fa-wifi" style="font-size:15px;"></i>' +
      '<span class="lab-sidebar-title">Wi-Fi Painter</span></a>';
    li.querySelector('a').addEventListener('click', function (e) {
      e.preventDefault(); window.pnqOverlayWifi();
    });
    var anchor = document.getElementById('pnq-protopainter');
    if (anchor && anchor.parentNode === ul) ul.insertBefore(li, anchor.nextSibling);
    else ul.appendChild(li);
    // Always-on: show connected clients automatically once the lab UI is up.
    setTimeout(autoStart, 800);
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
