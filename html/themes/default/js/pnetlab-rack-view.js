/**
 * pnetlab-rack-view.js — "Rack View" projection of the lab topology (Topology
 * Overlays sibling; see pnetlab-protocol-painter.js / pnetlab-topology-overlay.js).
 *
 * The protocol painter draws computed forwarding state onto the logical canvas.
 * THIS view takes the SAME CDP/LLDP adjacency (pnet_topomap) and projects the
 * nodes as faceplates mounted in equipment racks, so a learner sees how the
 * topology looks patched into real rack hardware: labelled switch faces with
 * their cabled ports lit green, jumpers within a rack, and inter-site cables
 * between racks in different locations.
 *
 * Backend: POST /pnq-overlay.php {action:'rack', rack_map}. The endpoint gathers
 * CDP, correlates to an adjacency, and runs pnet_racklayout to emit the geometry
 * {racks, cables, names, warnings}. SLICE 1 has no in-GUI assignment yet — the
 * placement comes from a rack_map JSON the user pastes into the panel (persisted
 * to localStorage); without one every node is parked in an "Unassigned" rack.
 *
 * Panel chrome reuses .pnq-ov-legend + .pnq-ov-head, so the overlay engine's
 * delegated drag handler moves it for free. Loads after the overlay engine
 * (index.html orders the scripts; all deferred).
 */
(function () {
  'use strict';

  var PANEL_ID = 'pnq-rack-panel';
  var MAP_KEY = 'pnq_rack_map';          // remembered rack_map (node -> rack)
  var RACKS_KEY = 'pnq_rack_extra';      // user-created (possibly empty) racks
  var SIZE_KEY = 'pnq_rack_size';        // remembered panel size {w,h} (resizable)
  var TRAFFIC_MS = 2000;                 // live-traffic poll interval
  var TRAFFIC_THRESH = 800;              // bytes/interval over which a link "flows"

  // ── faceplate / rack geometry constants ────────────────────────────────────
  var CELLW = 13, CELLH = 10, PITCH = 16, ROWGAP = 3;
  var LABELZONE = 82, FACE_H = 46, FACE_GAP = 12, FACE_PADX = 10;
  var RACK_TITLE_H = 34, RACK_PADX = 14, RACK_BOTTOM = 16, RACK_GAP = 28, MARGIN = 20;

  // ── small DOM + string helpers ─────────────────────────────────────────────
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function truncate(s, max) {
    s = String(s == null ? '' : s);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    if (p && p._detach) p._detach();          // drop the document drag listeners
    if (p && p._poll) clearInterval(p._poll); // stop the traffic poll
    if (p && p.parentNode) p.parentNode.removeChild(p);
  }

  // ── colours (hardware look — deliberately hard-coded, no theme inversion) ───
  var PORT_ON = '#46c46a', PORT_OFF = '#15171c', PORT_DOWN = '#e0564f',
    PORT_TRAFFIC = '#9be35f', PORT_STROKE = '#3a3d44';   // active/free/down/flowing
  var FACE_FILL = '#262931', FACE_STROKE = '#565b66';
  var BADGE = { switch: '#2d8cff', router: '#19b6a8', firewall: '#ff7a1a',
    generic: '#6b7280', network: '#8a63d2' };
  var BADGE_TEXT = { switch: '#08203f', router: '#04342c', firewall: '#3d1c00',
    generic: '#16181c', network: '#241546' };
  var NET_STROKE = '#8a63d2';            // patch-panel (network object) outline
  var CABLE_INTRA = '#46c46a', CABLE_INTER = '#2d8cff', CABLE_SITE = '#ff7a1a',
    CABLE_UPLINK = NET_STROKE;          // drop to a top external patch panel

  function faceLayout(fp) {
    var pc = Math.max(1, fp.port_count || 1);
    var rows = pc > 8 ? 2 : 1;
    var cols = rows === 2 ? Math.ceil(pc / 2) : pc;
    return { rows: rows, cols: cols, faceW: LABELZONE + cols * PITCH + FACE_PADX };
  }

  /* Centre of one faceplate port, by slot. 1-row faces sit a single centred row;
     wider faces stagger two rows (slot 0 top, 1 bottom, 2 top…) like a real RJ45
     switch face. Returns {x,y} of the port-square centre. */
  function portCentre(faceX, faceY, layout, slot) {
    var px = faceX + LABELZONE;
    var x, y;
    if (layout.rows === 1) {
      x = px + slot * PITCH;
      y = faceY + FACE_H / 2 - CELLH / 2;
    } else {
      var col = Math.floor(slot / 2), row = slot % 2;
      x = px + col * PITCH;
      y = (row === 0) ? faceY + 10 : faceY + 10 + CELLH + ROWGAP;
    }
    return { x: x + CELLW / 2, y: y + CELLH / 2, rx: x, ry: y };
  }

  /* Build the whole rack-view SVG from the backend geometry. Returns an SVG
     string. Records every port centre so cables can be drawn between real slots.
     Layout: a top "Uplinks" band of external (cloud/NAT/management) patch panels,
     then the equipment racks below. */
  function buildSvg(data) {
    var racks = (data && data.racks) ? data.racks : [];
    var uplinks = (data && data.uplinks) ? data.uplinks : [];
    var cables = (data && data.cables) ? data.cables : [];
    if (!racks.length && !uplinks.length) {
      return { svg: '<svg width="320" height="80" xmlns="http://www.w3.org/2000/svg">' +
        '<text x="16" y="44" fill="#9aa7b2" font-family="sans-serif" font-size="13">' +
        'Nothing to rack — this lab has no nodes.</text></svg>', zones: [] };
    }

    var centres = {};                    // "node/slot" -> {x,y}
    var locOf = {};                      // unit key -> location (for inter-site)
    var unitGroups = [], rails = [], frames = [], labels = [], zones = [];

    // Build one faceplate's SVG at (faceX,faceY); record its port centres + the
    // unit's location. Returns { w, svg } (svg = faceplate + ports, unwrapped).
    function drawFace(u, faceX, faceY, loc) {
      var fp = u.faceplate, fl = faceLayout(fp);
      locOf[u.node] = loc;
      var isNet = fp.kind === 'network';
      var stroke = fp.border || (isNet ? NET_STROKE : FACE_STROKE), sw = fp.border ? 2 : 1;
      var dash = isNet ? ' stroke-dasharray="4 3"' : '';
      var s = '<rect x="' + faceX + '" y="' + faceY + '" width="' + fl.faceW +
        '" height="' + FACE_H + '" rx="4" fill="' + FACE_FILL + '" stroke="' + stroke +
        '" stroke-width="' + sw + '"' + dash + '/>';

      var bcol = BADGE[fp.kind] || BADGE.generic, btx = BADGE_TEXT[fp.kind] || '#000';
      var vlabel = truncate(fp.vendor || 'Node', 11);
      var badgeW = Math.min(LABELZONE - 12, vlabel.length * 6.6 + 12);
      s += '<rect x="' + (faceX + 6) + '" y="' + (faceY + 6) + '" width="' +
        badgeW.toFixed(0) + '" height="15" rx="3" fill="' + bcol + '"/>' +
        '<text x="' + (faceX + 6 + badgeW / 2) + '" y="' + (faceY + 17) +
        '" fill="' + btx + '" font-family="sans-serif" font-size="11" font-weight="500" ' +
        'text-anchor="middle">' + esc(vlabel) + '</text>';
      var nameLine = isNet ? 'patch panel' : truncate(u.name, 12);
      s += '<text x="' + (faceX + 6) + '" y="' + (faceY + FACE_H - 7) +
        '" fill="#cfd3da" font-family="sans-serif" font-size="11">' + esc(nameLine) + '</text>';

      fp.ports.forEach(function (p) {
        var key = u.node + '/' + p.slot;
        var c = portCentre(faceX, faceY, fl, p.slot);
        centres[key] = { x: c.x, y: c.y };
        var st = p.state || (p.cabled ? 'active' : 'free');
        var fill = st === 'active' ? PORT_ON : (st === 'suspended' ? PORT_DOWN : PORT_OFF);
        var pk = peerOf[key];
        var tip = (st === 'free') ? 'free'
          : (esc(p.ifname) + (pk && portInfo[pk]
                ? '  →  ' + esc(portInfo[pk].name) + ' ' + esc(portInfo[pk].ifname) : '')
              + (st === 'suspended' ? '  (suspended)' : ''));
        s += '<rect class="rv-port" data-pk="' + esc(key) + '" data-if="' + esc(p.ifname) +
          '" data-cabled="' + (p.cabled ? '1' : '0') + '" x="' + c.rx + '" y="' + c.ry +
          '" width="' + CELLW + '" height="' + CELLH + '" rx="1.5" fill="' + fill +
          '" stroke="' + PORT_STROKE + '"><title>' + tip + '</title></rect>';
      });
      return { w: fl.faceW, svg: s };
    }

    // Wrap a faceplate as a unit group. Device units are draggable (rv-unit);
    // patch panels (network kind) are fixed (rv-net, follow their members).
    function pushUnit(u, faceX, faceY, loc) {
      var r = drawFace(u, faceX, faceY, loc);
      var cls = (u.faceplate.kind === 'network') ? 'rv-unit rv-net' : 'rv-unit';
      unitGroups.push('<g class="' + cls + '" data-node="' + esc(u.node) + '">' + r.svg + '</g>');
      return r.w;
    }

    // Port index + peer map: a port knows its Z-side (for hover glow + the title
    // that names where the cable goes). Filled before any drawFace call below.
    var portInfo = {}, peerOf = {};
    function indexUnit(u) {
      u.faceplate.ports.forEach(function (p) {
        portInfo[u.node + '/' + p.slot] = { name: u.name, ifname: p.ifname,
          state: p.state || (p.cabled ? 'active' : 'free') };
      });
    }
    uplinks.forEach(indexUnit);
    racks.forEach(function (r) { r.units.forEach(indexUnit); });
    cables.forEach(function (cb) {
      var ak = cb.a_node + '/' + cb.a_slot, bk = cb.b_node + '/' + cb.b_slot;
      peerOf[ak] = bk; peerOf[bk] = ak;
    });

    // ── top uplinks band (external clouds / NAT / management) ─────────────────
    var racksY0 = MARGIN, bandRight = MARGIN;
    if (uplinks.length) {
      labels.push('<text x="' + MARGIN + '" y="' + (MARGIN + 10) + '" fill="#9aa7b2" ' +
        'font-family="sans-serif" font-size="12" font-weight="500">Uplinks · external</text>');
      var bandTop = MARGIN + 18, bx = MARGIN;
      uplinks.forEach(function (u) { bx += pushUnit(u, bx, bandTop, '__ext__') + 24; });
      bandRight = bx - 24;
      racksY0 = bandTop + FACE_H + 30;
    }

    // Reserve an overhead conduit lane ABOVE the rack name labels, so inter-rack /
    // inter-site cables run over the top of the racks instead of cutting through
    // the names. The tray sits in the reserved strip; titles get a background
    // plate (below) so the risers drop behind the name rather than across it.
    var hasInter = cables.some(function (c) { return c.scope === 'inter'; });
    if (hasInter) racksY0 += 44;
    var condTop = racksY0 - 24;

    // ── equipment racks ───────────────────────────────────────────────────────
    var x = MARGIN, maxBottom = racksY0;
    racks.forEach(function (rack) {
      var faceWs = rack.units.map(function (u) { return faceLayout(u.faceplate).faceW; });
      var rackW = Math.max.apply(null, faceWs.concat([200])) + 2 * RACK_PADX;
      var empty = rack.units.length === 0;
      var rackH = empty ? 84
        : RACK_TITLE_H + rack.units.length * (FACE_H + FACE_GAP) + RACK_BOTTOM;
      var rackX = x, rackY = racksY0;

      frames.push('<rect x="' + rackX + '" y="' + rackY + '" width="' + rackW +
        '" height="' + rackH + '" rx="8" fill="none" stroke="#8a8f99"/>');
      rails.push('<rect x="' + (rackX + 6) + '" y="' + (rackY + 15) + '" width="6" height="' +
        (rackH - 30) + '" fill="#3a3d44"/><rect x="' + (rackX + rackW - 12) + '" y="' +
        (rackY + 15) + '" width="6" height="' + (rackH - 30) + '" fill="#3a3d44"/>');
      var title = esc(rack.id) + (rack.location ? '  ·  ' + esc(rack.location) : '');
      var titleW = (String(rack.id).length + (rack.location ? String(rack.location).length + 3 : 0))
        * 7 + 8;
      labels.push('<rect x="' + (rackX - 2) + '" y="' + (rackY - 18) + '" width="' + titleW +
        '" height="17" fill="#0f1115"/><text x="' + rackX + '" y="' + (rackY - 6) +
        '" fill="#e6edf3" font-family="sans-serif" font-size="13" font-weight="500">' +
        title + '</text>');
      // delete control on every rack but the default "Unassigned" — clicking it
      // sends the rack's nodes back to Unassigned and drops the rack.
      if (String(rack.id) !== 'Unassigned') {
        labels.push('<g class="rv-rack-del" data-rack="' + esc(rack.id) + '" data-loc="' +
          esc(rack.location || '') + '" style="cursor:pointer"><title>Delete rack — nodes move to Unassigned</title>' +
          '<rect x="' + (rackX + rackW - 19) + '" y="' + (rackY - 18) + '" width="15" height="15" rx="3" ' +
          'fill="#2a1416" stroke="#e0564f"/><text x="' + (rackX + rackW - 11.5) + '" y="' + (rackY - 6.5) +
          '" fill="#e0564f" font-family="sans-serif" font-size="12" text-anchor="middle">✕</text></g>');
      }

      // record device-unit vertical midpoints (in rack order) so a drag-drop can
      // compute an insertion index and reorder within the rack (network patch
      // panels aren't draggable, so they're excluded).
      var rackUnits = [];
      if (empty) {
        labels.push('<text x="' + (rackX + rackW / 2) + '" y="' + (rackY + 48) +
          '" fill="#5f6b76" font-family="sans-serif" font-size="12" text-anchor="middle">' +
          'drop nodes here</text>');
      } else {
        var faceY = rackY + RACK_TITLE_H;
        rack.units.forEach(function (u) {
          pushUnit(u, rackX + RACK_PADX, faceY, rack.location);
          if (u.faceplate.kind !== 'network') {
            rackUnits.push({ node: u.node, yMid: faceY + FACE_H / 2 });
          }
          faceY += FACE_H + FACE_GAP;
        });
      }
      zones.push({ id: rack.id, location: rack.location || '',
        x: rackX, y: rackY, w: rackW, h: rackH, units: rackUnits });

      maxBottom = Math.max(maxBottom, rackY + rackH);
      x = rackX + rackW + RACK_GAP;
    });

    // Cables over the faceplates, between recorded port centres. uplink (drop to a
    // top external panel) = purple; intra-rack = green jumper bowed to the side;
    // cross-rack = blue; inter-site = orange dashed. Skip if an endpoint is missing.
    var wires = [], interIdx = 0;
    cables.forEach(function (cb) {
      var ak = cb.a_node + '/' + cb.a_slot, bk = cb.b_node + '/' + cb.b_slot;
      var a = centres[ak], b = centres[bk];
      if (!a || !b) return;
      var col, dash = '';
      if (cb.scope === 'uplink') {
        col = CABLE_UPLINK;
      } else if (cb.scope === 'intra') {
        col = CABLE_INTRA;
      } else {
        var crossLoc = locOf[cb.a_node] !== locOf[cb.b_node];
        col = crossLoc ? CABLE_SITE : CABLE_INTER;
        dash = crossLoc ? ' stroke-dasharray="5 3"' : '';
      }
      var d;
      if (cb.scope === 'intra') {
        var bow = Math.max(a.x, b.x) + 34;             // bow out to the right
        d = 'M' + a.x + ' ' + a.y + ' C' + bow + ' ' + a.y + ' ' + bow + ' ' + b.y +
          ' ' + b.x + ' ' + b.y;
      } else if (cb.scope === 'inter') {
        var cy = condTop - (interIdx % 6) * 4; interIdx++;   // up into the overhead tray
        d = 'M' + a.x + ' ' + a.y + ' L' + a.x + ' ' + cy + ' L' + b.x + ' ' + cy +
          ' L' + b.x + ' ' + b.y;
      } else {                                          // uplink: curve up to the band
        var mx = (a.x + b.x) / 2;
        d = 'M' + a.x + ' ' + a.y + ' C' + mx + ' ' + a.y + ' ' + mx + ' ' + b.y +
          ' ' + b.x + ' ' + b.y;
      }
      wires.push('<path class="rv-cable" data-a="' + esc(ak) + '" data-b="' + esc(bk) +
        '" d="' + d + '" fill="none" stroke="' + col + '" stroke-width="2"' + dash + '/>');
    });

    // legend strip below the racks
    var ly = maxBottom + 22, lx = MARGIN;
    var legend = '<g font-family="sans-serif" font-size="12" fill="#9aa7b2">' +
      sw_swatch(lx, ly, PORT_ON) + txt(lx + 20, ly + 10, 'active') +
      sw_swatch(lx + 70, ly, PORT_DOWN) + txt(lx + 90, ly + 10, 'down') +
      sw_swatch(lx + 138, ly, PORT_OFF) + txt(lx + 158, ly + 10, 'free') +
      line_swatch(lx + 210, ly + 5, CABLE_INTRA, false) + txt(lx + 238, ly + 10, 'intra-rack') +
      line_swatch(lx + 312, ly + 5, CABLE_INTER, false) + txt(lx + 340, ly + 10, 'cross-rack') +
      line_swatch(lx + 416, ly + 5, CABLE_SITE, true) + txt(lx + 444, ly + 10, 'inter-site') +
      line_swatch(lx + 518, ly + 5, CABLE_UPLINK, false) + txt(lx + 546, ly + 10, 'uplink') +
      '<rect x="' + (lx + 608) + '" y="' + ly + '" width="' + CELLW + '" height="' + CELLH +
      '" rx="1.5" fill="' + FACE_FILL + '" stroke="' + NET_STROKE +
      '" stroke-dasharray="4 3"/>' + txt(lx + 628, ly + 10, 'patch panel') +
      sw_swatch(lx + 716, ly, PORT_TRAFFIC) + txt(lx + 736, ly + 10, 'traffic') +
      '</g>';

    var w = Math.max(x - RACK_GAP + MARGIN, bandRight + MARGIN, lx + 800);
    var h = ly + 26;
    var svg = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
      '" xmlns="http://www.w3.org/2000/svg">' +
      frames.join('') + rails.join('') + unitGroups.join('') +
      wires.join('') + labels.join('') + legend + '</svg>';
    return { svg: svg, zones: zones };
  }
  function sw_swatch(x, y, fill) {
    return '<rect x="' + x + '" y="' + y + '" width="' + CELLW + '" height="' + CELLH +
      '" rx="1.5" fill="' + fill + '" stroke="' + PORT_STROKE + '"/>';
  }
  function line_swatch(x, y, col, dashed) {
    return '<line x1="' + x + '" y1="' + y + '" x2="' + (x + 22) + '" y2="' + y +
      '" stroke="' + col + '" stroke-width="2"' + (dashed ? ' stroke-dasharray="5 3"' : '') + '/>';
  }
  function txt(x, y, s) {
    return '<text x="' + x + '" y="' + y + '">' + esc(s) + '</text>';
  }

  /* Wire hover highlighting on the rendered SVG: hovering a port glows it + its
     Z-side port + the cable between; hovering a cable glows both its end ports.
     Cables use pointer-events:stroke (CSS) so they don't shadow the ports. */
  function attachInteractions(root) {
    var portEls = {};
    root.querySelectorAll('rect.rv-port').forEach(function (p) {
      portEls[p.getAttribute('data-pk')] = p;
    });
    var byPort = {};
    var cableEls = root.querySelectorAll('path.rv-cable');
    cableEls.forEach(function (c) {
      [c.getAttribute('data-a'), c.getAttribute('data-b')].forEach(function (k) {
        (byPort[k] = byPort[k] || []).push(c);
      });
    });
    function glow(key, on) {
      if (portEls[key]) portEls[key].classList.toggle('rv-hl', on);
      (byPort[key] || []).forEach(function (c) {
        c.classList.toggle('rvc-hl', on);
        var a = c.getAttribute('data-a'), b = c.getAttribute('data-b');
        var other = (a === key) ? b : a;
        if (portEls[other]) portEls[other].classList.toggle('rv-hl', on);
      });
    }
    Object.keys(portEls).forEach(function (key) {
      portEls[key].addEventListener('mouseenter', function () { glow(key, true); });
      portEls[key].addEventListener('mouseleave', function () { glow(key, false); });
    });
    cableEls.forEach(function (c) {
      function set(on) {
        c.classList.toggle('rvc-hl', on);
        [c.getAttribute('data-a'), c.getAttribute('data-b')].forEach(function (k) {
          if (portEls[k]) portEls[k].classList.toggle('rv-hl', on);
        });
      }
      c.addEventListener('mouseenter', function () { set(true); });
      c.addEventListener('mouseleave', function () { set(false); });
    });
  }

  // ── panel ──────────────────────────────────────────────────────────────────
  function parseMap(raw) {
    raw = (raw || '').trim();
    if (!raw) return {};
    try {
      var m = JSON.parse(raw);
      return (m && typeof m === 'object') ? m : {};
    } catch (e) { return null; }       // null = invalid (caller surfaces an error)
  }
  function loadJSON(key, dflt) {
    try { var v = JSON.parse(localStorage.getItem(key) || ''); return (v == null) ? dflt : v; }
    catch (e) { return dflt; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function persist(panel) {
    localStorage.setItem(MAP_KEY, JSON.stringify(panel._rackMap || {}));
    localStorage.setItem(RACKS_KEY, JSON.stringify(panel._extra || []));
  }
  function syncTextarea(panel) {
    var ta = panel.querySelector('.pnq-rack-ta');
    if (ta) ta.value = JSON.stringify(panel._rackMap || {});
  }

  /* Delete a rack: send its nodes back to the default "Unassigned" rack (clear
     their map entries) and drop any user-created entry for it. The Unassigned
     rack is the fallback and can't be deleted. */
  function deleteRack(panel, rackId, location) {
    if (!rackId || String(rackId) === 'Unassigned') return;
    Object.keys(panel._rackMap || {}).forEach(function (nd) {
      var m = panel._rackMap[nd];
      if (m && String(m.rack) === String(rackId) && (m.location || '') === (location || '')) {
        delete panel._rackMap[nd];
      }
    });
    panel._extra = (panel._extra || []).filter(function (e) {
      return !(String(e.rack) === String(rackId) && (e.location || '') === (location || ''));
    });
    persist(panel); syncTextarea(panel); render(panel);
  }

  /* Drag a device faceplate onto a rack to assign it. Returns a detach fn for the
     document-level listeners (called before each re-render so they don't stack).
     A drop into the "Unassigned" rack clears the assignment. */
  function attachDrag(svgEl, zones, onDrop) {
    if (!svgEl) return function () {};
    var on = false, gEl = null, sx = 0, sy = 0, node = null, moved = false;
    function down(e) {
      var g = e.target.closest ? e.target.closest('g.rv-unit') : null;
      if (!g || g.classList.contains('rv-net') || e.button !== 0) return;
      on = true; moved = false; gEl = g; node = g.getAttribute('data-node');
      sx = e.clientX; sy = e.clientY;
      e.preventDefault();
    }
    function move(e) {
      if (!on) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; gEl.classList.add('rv-dragging'); }
      gEl.setAttribute('transform', 'translate(' + dx + ',' + dy + ')');
    }
    function up(e) {
      if (!on) return;
      on = false;
      gEl.classList.remove('rv-dragging'); gEl.removeAttribute('transform');
      var n = node; gEl = null; node = null;
      if (!moved) return;                              // a click, not a drag
      var r = svgEl.getBoundingClientRect();
      var px = e.clientX - r.left, py = e.clientY - r.top, hit = null;
      zones.forEach(function (z) {
        if (px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h) hit = z;
      });
      if (hit) onDrop(n, hit, py);
    }
    svgEl.addEventListener('mousedown', down);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    return function () {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
  }

  // ── live-traffic glow ───────────────────────────────────────────────────────
  // Poll the lightweight rack-traffic endpoint, delta the per-interface byte
  // counters, and pulse a port (+ its cable + Z-side) light-green when its link
  // is carrying traffic. Counters are read from sysfs, so this is cheap.
  function stopTraffic(panel) {
    if (panel._poll) { clearInterval(panel._poll); panel._poll = null; }
  }
  /* Recolour ports to the canvas's live truth: a cabled port is green when its
     tap carrier is up, red when down (or its node is stopped), and pulses light-
     green while flowing. When no lab is running we leave the static .unl colours.
     Patch-panel (rv-net) and free ports are left as-is. */
  function applyLive(canvas, up, flow, running) {
    var portEl = {};
    canvas.querySelectorAll('rect.rv-port').forEach(function (p) {
      portEl[p.getAttribute('data-pk')] = p;
      p.classList.remove('rv-up', 'rv-down', 'rv-traffic');
    });
    var cables = canvas.querySelectorAll('path.rv-cable');
    if (!running) {                       // nothing live to show -> static colours
      cables.forEach(function (c) { c.classList.remove('rv-traffic', 'rv-cabledown'); });
      return;
    }
    var down = {};
    Object.keys(portEl).forEach(function (pk) {
      var p = portEl[pk];
      if (p.closest('g.rv-net')) return;                  // patch-panel port: static
      if (p.getAttribute('data-cabled') !== '1') return;  // free port stays dark
      var key = pk.split('/')[0] + '/' + (p.getAttribute('data-if') || '');
      if (up[key] === true) {
        p.classList.add('rv-up');
        if (flow[key]) p.classList.add('rv-traffic');
      } else {
        p.classList.add('rv-down'); down[pk] = true;
      }
    });
    cables.forEach(function (c) {
      var a = c.getAttribute('data-a'), b = c.getAttribute('data-b');
      var isDown = down[a] || down[b];
      c.classList.toggle('rv-cabledown', !!isDown);       // dim a down link
      var flowing = !isDown && ((portEl[a] && portEl[a].classList.contains('rv-traffic')) ||
                                (portEl[b] && portEl[b].classList.contains('rv-traffic')));
      c.classList.toggle('rv-traffic', !!flowing);
      if (flowing) {                                       // carry glow to the Z-side port
        if (portEl[a]) portEl[a].classList.add('rv-traffic');
        if (portEl[b]) portEl[b].classList.add('rv-traffic');
      }
    });
  }
  function startTraffic(panel) {
    stopTraffic(panel);
    var prev = null;
    function poll() {
      var canvas = panel.querySelector('.pnq-rack-canvas');
      if (!canvas) return;
      fetch('/pnq-overlay.php', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rack-traffic' })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d) return;
        var cur = d.traffic || {}, flow = {};
        if (prev) {
          Object.keys(cur).forEach(function (k) {
            if (prev[k] != null && cur[k] - prev[k] > TRAFFIC_THRESH) flow[k] = true;
          });
        }
        prev = cur;
        var cv = panel.querySelector('.pnq-rack-canvas');
        if (cv) applyLive(cv, d.up || {}, flow, !!d.running);
      }).catch(function () {});
    }
    poll();
    panel._poll = setInterval(poll, TRAFFIC_MS);
  }

  function render(panel) {
    var body = panel.querySelector('.pnq-rack-body');
    body.innerHTML = '<div class="pnq-rack-msg" style="color:#9aa7b2">Reading topology…</div>';
    if (panel._detach) { panel._detach(); panel._detach = null; }
    stopTraffic(panel);
    fetch('/pnq-overlay.php', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rack', rack_map: panel._rackMap || {} })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.error) {
        body.innerHTML = '<div class="pnq-rack-msg" style="color:#f0997b">' +
          esc(data.error) + '</div>';
        return;
      }
      data.racks = data.racks || [];
      // user-created racks that hold no nodes yet still render as drop targets
      (panel._extra || []).forEach(function (ex) {
        var exists = data.racks.some(function (r) {
          return r.id === ex.rack && (r.location || '') === (ex.location || '');
        });
        if (!exists) data.racks.push({ id: ex.rack, location: ex.location || '', units: [] });
      });
      var res = buildSvg(data);
      panel._lastSvg = res.svg;
      var warnings = (data.warnings && data.warnings.length) ? data.warnings : [];
      var warn = warnings.length
        ? '<div class="pnq-rack-msg pnq-rack-warnings" role="status">' +
          '<div class="pnq-rack-warning-count">' + warnings.length +
          (warnings.length === 1 ? ' node has' : ' nodes have') +
          ' no rack mapping.</div>' +
          '<ul class="pnq-rack-warning-list">' +
          warnings.map(function (warning) { return '<li>' + esc(warning) + '</li>'; }).join('') +
          '</ul></div>' : '';
      body.innerHTML = '<div class="pnq-rack-canvas">' + res.svg + '</div>' + warn;
      var canvas = body.querySelector('.pnq-rack-canvas');
      if (!canvas) return;
      attachInteractions(canvas);
      panel._detach = attachDrag(canvas.querySelector('svg'), res.zones, function (nd, zone, dropY) {
        if (zone.id === 'Unassigned') {
          delete panel._rackMap[nd];
        } else {
          // Reorder/insert by drop position: take the device units already in this
          // rack (top-to-bottom), drop the dragged one in, then renumber u=1..N so
          // the backend (which sorts units by u) renders the new order. This lets a
          // lower node be moved to a higher slot within the same rack, not just
          // appended to the bottom.
          var others = (zone.units || []).filter(function (u) { return String(u.node) !== String(nd); });
          var idx = 0;
          others.forEach(function (u) { if (u.yMid < dropY) idx++; });
          var ids = others.map(function (u) { return u.node; });
          ids.splice(idx, 0, nd);
          ids.forEach(function (id, i) {
            panel._rackMap[id] = { rack: zone.id, location: zone.location || '', u: i + 1 };
          });
        }
        persist(panel); syncTextarea(panel); render(panel);
      });
      // rack delete controls (✕ on each rack title)
      canvas.querySelectorAll('.rv-rack-del').forEach(function (g) {
        g.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var rid = g.getAttribute('data-rack');
          if (!window.confirm('Delete rack "' + rid + '"?\nIts nodes move back to Unassigned.')) return;
          deleteRack(panel, rid, g.getAttribute('data-loc') || '');
        });
      });
      startTraffic(panel);
    }).catch(function () {
      body.innerHTML = '<div class="pnq-rack-msg" style="color:#f0997b">' +
        'Rack View request failed.</div>';
    });
  }

  function openInTab(panel) {
    if (!panel._lastSvg) return;
    var w = window.open('', '_blank');
    if (!w) return;
    w.document.write('<!doctype html><title>Rack View</title>' +
      '<body style="margin:0;background:#0f1115;display:flex;justify-content:center;' +
      'padding:24px;">' + panel._lastSvg + '</body>');
    w.document.close();
  }

  function buildPanel() {
    closePanel();
    var box = el('div', 'pnq-ov-legend'); box.id = PANEL_ID;
    // Resizable panel with a sensible default (the rack SVG is wide, so the old
    // width:auto/76vw filled most of the screen). Drag the bottom-right corner to
    // resize; the rack body scrolls inside. Restore the last size the user set.
    var sz = loadJSON(SIZE_KEY, null);
    box.style.boxSizing = 'border-box';
    box.style.width = (sz && sz.w) ? (sz.w + 'px') : 'min(840px, 92vw)';
    box.style.height = (sz && sz.h) ? (sz.h + 'px') : 'min(600px, 82vh)';
    box.style.maxWidth = '96vw';
    box.style.maxHeight = '92vh';
    box.style.minWidth = '360px';
    box.style.minHeight = '240px';
    box.style.resize = 'both';
    box.style.overflow = 'hidden';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    // persist the chosen size (ResizeObserver fires on the user's drag-resize)
    try {
      new ResizeObserver(function () {
        if (box.offsetWidth && box.offsetHeight)
          saveJSON(SIZE_KEY, { w: box.offsetWidth, h: box.offsetHeight });
      }).observe(box);
    } catch (e) {}
    box._rackMap = loadJSON(MAP_KEY, {});
    box._extra = loadJSON(RACKS_KEY, []);
    if (typeof box._rackMap !== 'object' || box._rackMap === null) box._rackMap = {};
    if (!Array.isArray(box._extra)) box._extra = [];

    var head = el('div', 'pnq-ov-head');
    head.appendChild(el('span', 'pnq-ov-title', 'Rack View'));
    var actions = el('span');
    var tabBtn = el('button', 'pnq-ov-clear', 'Open in tab');
    tabBtn.style.marginRight = '6px';
    tabBtn.addEventListener('click', function () { openInTab(box); });
    var close = el('button', 'pnq-ov-clear', 'Close');
    close.addEventListener('click', closePanel);
    actions.appendChild(tabBtn); actions.appendChild(close);
    head.appendChild(actions);
    box.appendChild(head);

    // toolbar: create a rack to drag nodes into
    var bar = el('div', 'pnq-rack-bar');
    var rName = el('input', 'pnq-rack-in'); rName.placeholder = 'Rack name';
    var rLoc = el('input', 'pnq-rack-in'); rLoc.placeholder = 'Location';
    var addBtn = el('button', 'pnq-rack-add', 'Add rack');
    addBtn.addEventListener('click', function () {
      var nm = (rName.value || '').trim(); if (!nm) { rName.focus(); return; }
      var lc = (rLoc.value || '').trim();
      if (!box._extra.some(function (e) { return e.rack === nm && (e.location || '') === lc; })) {
        box._extra.push({ rack: nm, location: lc });
      }
      rName.value = ''; rLoc.value = '';
      persist(box); render(box);
    });
    bar.appendChild(rName); bar.appendChild(rLoc); bar.appendChild(addBtn);
    bar.appendChild(el('span', 'pnq-rack-hint', 'Drag a faceplate onto a rack to place it.'));
    box.appendChild(bar);

    // advanced: the raw rack map (stays in sync with drags). A button toggles it
    // open/closed (was a <details>/<summary> text disclosure).
    var jsonWrap = el('div', 'pnq-rack-map');
    var jsonToggle = el('button', 'pnq-rack-add', '{ }  Rack map (JSON)');
    jsonToggle.style.marginBottom = '6px';
    var jsonBody = el('div');
    jsonBody.style.display = 'none';
    var ta = el('textarea', 'pnq-rack-ta');
    ta.placeholder = '{ "1": {"rack":"Rack 01","location":"DC-East","u":1} }';
    ta.value = JSON.stringify(box._rackMap);
    jsonBody.appendChild(ta);
    var apply = el('button', 'pnq-pp-paint', 'Apply JSON');
    apply.style.marginTop = '6px';
    apply.addEventListener('click', function () {
      var m = parseMap(ta.value);
      if (m === null) { ta.style.borderColor = '#f0997b'; return; }
      ta.style.borderColor = '';
      box._rackMap = m; persist(box); render(box);
    });
    jsonBody.appendChild(apply);
    jsonToggle.addEventListener('click', function () {
      var open = jsonBody.style.display === 'none';
      jsonBody.style.display = open ? 'block' : 'none';
      if (open) ta.value = JSON.stringify(box._rackMap);   // refresh on open (drags update it)
    });
    jsonWrap.appendChild(jsonToggle); jsonWrap.appendChild(jsonBody);
    box.appendChild(jsonWrap);

    box.appendChild(el('div', 'pnq-rack-body'));
    document.body.appendChild(box);
    render(box);
  }

  function openPanel(e) {
    if (e) e.preventDefault();
    buildPanel();
  }

  // ── inject the sidebar entry (mirror pnetlab-protocol-painter.js) ───────────
  function inject() {
    if (document.getElementById('pnq-rackview')) return true;
    var ul = document.querySelector('#lab-sidebar ul');
    if (!ul) return false;
    var li = el('li');
    li.id = 'pnq-rackview';
    li.innerHTML = '<a href="javascript:void(0)" title="See the topology laid out in equipment racks">' +
      '<i class="fa fa-server" style="font-size:15px;"></i>' +
      '<span class="lab-sidebar-title">Rack View</span></a>';
    li.querySelector('a').addEventListener('click', openPanel);
    var anchor = document.getElementById('pnq-protopainter');
    if (anchor && anchor.parentNode === ul) ul.insertBefore(li, anchor.nextSibling);
    else ul.appendChild(li);
    return true;
  }

  // Exposed for offline render-verification and the future standalone pop-out
  // page (slice 3) — mirrors the window.pnqOverlay* entry points.
  window.pnqRackBuildSvg = buildSvg;

  function init() {
    if (inject()) return;
    var mo = new MutationObserver(function () { if (inject()) mo.disconnect(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
