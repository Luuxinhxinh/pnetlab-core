/**
 * pnetlab-network-watcher.js — Network Watcher: per-link traffic visualisation
 * for the lab topology (educational: watch OSPF hellos, BGP keepalives, BPDUs,
 * pings... flow on the links they actually cross).
 *
 * UI: a sidebar entry opens a small panel where the user defines up to 6
 * filters (protocol preset + optional src/dst IP, port, proto) each with a
 * colour. Start → POST /pnq-linkwatch.php (server resolves links → taps and
 * spawns the engine-side watcher); then a 1 s GET poll drives the visuals:
 * every link with matching traffic gets a cloned SVG path overlaid on its
 * jsPlumb connector, coloured per filter, with a marching-dash animation that
 * runs in the traffic's direction (both ways = two clones). Hovering a lit
 * link shows per-filter pps + a last-packet summary.
 *
 * Lightweight by design: only counters/summaries cross the wire (~few KB/s),
 * the dash animation is pure compositor CSS (no rAF), polling pauses while
 * the tab is hidden, and everything tears down on Stop. Colours and filter
 * definitions live in sessionStorage only (reload reattaches to a running
 * watch); nothing is persisted with the lab.
 *
 * Link → connector mapping: connections are created by the lab bundle on the
 * global jsPlumb instance window.lab_topology with element ids node<id> /
 * network<id>; we match each watched link's endpoints against
 * getAllConnections() and clone into conn.connector.canvas (the per-connector
 * <svg>). jsPlumb rewrites the path's "d" on drag/zoom — a MutationObserver
 * plus the poll tick re-copies it to the clones (cheap string copy).
 *
 * CSP-safe: separate file (registered in themes/default/index.html), no
 * inline handlers; styles via stylesheet + element.style.
 */
(function () {
  'use strict';

  var URL = '/pnq-linkwatch.php';
  var SS_KEY = 'pnq_netwatch_v2';
  var LIT_WINDOW = 3.0;           // seconds since last_ts to keep a link lit
  var MAX_FILTERS = 6;
  var MAX_CLONES_PER_LINK = 12;   // up to 6 filters × 2 directions per link
  var LANE_SP = 9;                // px gap between parallel protocol/direction lanes
                                  // (9: lanes read as clearly OFF the link at 100% zoom)

  // [id, label, defaultColor, supportsIpVersion]
  // [slug, label, defaultColor, hasIPver, subtypeSpec]
  // subtypeSpec: null = no subtypes; array = slug list; {arg:'label'} = numeric arg
  var PRESETS = [
    ['all',   'All traffic',   '#607d8b', false, null],
    ['arp',   'ARP',           '#795548', false, null],
    ['ospf',  'OSPF',          '#ff9800', true,  [{s:'hello',l:'Hello'},{s:'dbd',l:'DBD'},{s:'lsr',l:'LSR'},{s:'lsu',l:'LSU'},{s:'lsack',l:'LSAck'}]],
    ['bgp',   'BGP',           '#2196f3', true,  [{s:'open',l:'OPEN',v4:1},{s:'update',l:'UPDATE',v4:1},{s:'notification',l:'NOTIFICATION',v4:1},{s:'keepalive',l:'KEEPALIVE',v4:1}]],
    ['eigrp', 'EIGRP',         '#9c6b3f', true,  [{s:'update',l:'Update',v4:1},{s:'query',l:'Query',v4:1},{s:'reply',l:'Reply',v4:1},{s:'hello-ack',l:'Hello / ACK',v4:1},{s:'sia-query',l:'SIA-Query',v4:1},{s:'sia-reply',l:'SIA-Reply',v4:1}]],
    ['isis',  'IS-IS',         '#e91e63', false, [{s:'hello',l:'Hello'},{s:'lsp',l:'LSP'},{s:'csnp',l:'CSNP'},{s:'psnp',l:'PSNP'}]],
    ['rip',   'RIP',           '#00bcd4', true,  [{s:'request',l:'Request',v4:1},{s:'response',l:'Response',v4:1}]],
    ['ping',  'Ping (echo)',   '#4caf50', true,  [{s:'echo-req',l:'Echo Request'},{s:'echo-reply',l:'Echo Reply'}]],
    ['icmp',  'ICMP (all)',    '#8bc34a', true,  [{s:'echo-req',l:'Echo Req'},{s:'echo-reply',l:'Echo Reply'},{s:'unreach',l:'Unreachable'},{s:'ttl-exceeded',l:'TTL Exceeded'},{s:'redirect',l:'Redirect',v4:1}]],
    ['stp',   'STP / BPDU',    '#9c27b0', false, [{s:'config',l:'Config'},{s:'tcn',l:'TCN'},{s:'rstp',l:'RSTP'}]],
    ['cdp',   'CDP',           '#ff5722', false, null],
    ['lldp',  'LLDP',          '#26a69a', false, null],
    ['vxlan', 'VXLAN',         '#3f51b5', true,  {arg:'VNI'}],
    ['lisp',  'LISP',          '#5c6bc0', true,  [{s:'map-request',l:'Map-Req',v4:1},{s:'map-reply',l:'Map-Reply',v4:1},{s:'map-register',l:'Map-Reg',v4:1},{s:'map-notify',l:'Map-Notify',v4:1}]],
    ['gre',   'GRE',           '#7cb342', true,  null],
    ['ipsec', 'IPsec',         '#673ab7', true,  [{s:'esp',l:'ESP'},{s:'ah',l:'AH'},{s:'isakmp',l:'ISAKMP / IKE'}]],
    ['radius','RADIUS',        '#8d6e63', true,  [{s:'auth',l:'Auth (1812/1645)'},{s:'acct',l:'Accounting (1813/1646)'}]],
    ['tacacs','TACACS+',       '#455a64', true,  null],
    ['dot1q', '802.1Q tagged', '#ffc107', false, null],
    ['custom','Custom fields', '#f44336', true,  null]
  ];
  function presetDef(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i][0] === id) return PRESETS[i];
    return PRESETS[0];
  }

  // UI "speed" → snapshot/poll cadence in seconds
  var SPEEDS = [['1', 'Normal (1s)', 1.0], ['0.5', 'Fast (0.5s)', 0.5],
                ['0.25', 'Real-time (0.25s)', 0.25]];

  var state = {
    running: false,
    filters: [],          // [{preset,version,src_ip,dst_ip,port,proto,color}]
    links: [],            // from server: [{key,tap,network_id,flip,src,dst}]
    conns: {},            // link key -> {conn, svg, base, drawnFlip} | null
    clones: {},           // link key -> { fid_dir: pathEl }
    snap: null,           // latest snapshot
    timer: null,
    obs: null,
    speed: 1.0,           // seconds between snapshots/polls
    startedAt: 0
  };
  function pollMs() { return Math.max(250, state.speed * 1000); }

  /* ── tiny helpers ────────────────────────────────────────────────────────── */
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function toast(kind, msg) {
    if (typeof window.addMessage === 'function') window.addMessage(kind, msg);
    else console.log('[netwatch]', kind, msg);
  }
  function saveSS() {
    try {
      sessionStorage.setItem(SS_KEY, JSON.stringify(
        { running: state.running, filters: state.filters, speed: state.speed }));
    } catch (e) {}
  }
  function loadSS() {
    try {
      var v = JSON.parse(sessionStorage.getItem(SS_KEY));
      if (v && Array.isArray(v.filters)) return v;
    } catch (e) {}
    return null;
  }
  (function () { var s = loadSS(); if (s && s.speed) state.speed = s.speed; })();

  /* ── panel ───────────────────────────────────────────────────────────────── */
  var panel = null;

  function presetOptions(sel) {
    return PRESETS.map(function (p) {
      return '<option value="' + p[0] + '"' + (p[0] === sel ? ' selected' : '') +
        '>' + p[1] + '</option>';
    }).join('');
  }

  function verOptions(sel) {
    return [['', 'IPv4/6'], ['4', 'IPv4'], ['6', 'IPv6']].map(function (v) {
      return '<option value="' + v[0] + '"' + (v[0] === (sel || '') ? ' selected' : '') +
        '>' + v[1] + '</option>';
    }).join('');
  }

  function subtypeOptions(preset, ver, curSubtype) {
    var def = presetDef(preset);
    var spec = def[4];
    if (!spec || spec.arg) return null;  // no list subtypes
    var ver6 = (ver === '6');
    var opts = '<option value="">any</option>';
    spec.forEach(function (st) {
      var disabled = (ver6 && st.v4) ? ' disabled' : '';
      var sel = (st.s === curSubtype) ? ' selected' : '';
      opts += '<option value="' + st.s + '"' + sel + disabled + '>' + st.l + '</option>';
    });
    return opts;
  }

  function filterRow(f, idx) {
    var row = el('div', 'pnq-nw-row');
    row.setAttribute('data-idx', idx);
    var curPreset = f.preset || 'ospf';
    var def0 = presetDef(curPreset);
    var spec0 = def0[4];
    var advHtml = '';
    if (spec0 && spec0.arg) {
      advHtml = '<input type="number" class="pnq-nw-subtype-arg" placeholder="' + spec0.arg +
        '" min="1" max="16777215" title="Subtype arg (' + spec0.arg + ')" value="' + (f.subtype_arg || '') + '">';
    } else if (spec0) {
      advHtml = '<select class="pnq-nw-subtype" title="Advanced subtype">' +
        (subtypeOptions(curPreset, f.version || '', f.subtype) || '') + '</select>';
    }
    row.innerHTML =
      '<button type="button" class="pnq-nw-color" title="Link colour"></button>' +
      '<select class="pnq-nw-preset" title="Protocol">' + presetOptions(curPreset) + '</select>' +
      '<select class="pnq-nw-ver" title="IP version">' + verOptions(f.version) + '</select>' +
      advHtml +
      '<input type="text" class="pnq-nw-src" placeholder="src IP" value="' + (f.src_ip || '') + '">' +
      '<input type="text" class="pnq-nw-dst" placeholder="dst IP" value="' + (f.dst_ip || '') + '">' +
      '<input type="number" class="pnq-nw-port" placeholder="port" min="1" max="65535" value="' + (f.port || '') + '">' +
      '<select class="pnq-nw-proto" title="L4 protocol">' +
        ['', 'tcp', 'udp', 'icmp'].map(function (p) {
          return '<option value="' + p + '"' + (p === (f.proto || '') ? ' selected' : '') + '>' +
            (p || 'any') + '</option>';
        }).join('') + '</select>' +
      '<button type="button" class="pnq-nw-del" title="Remove filter">&times;</button>' +
      '<span class="pnq-nw-pps" data-fid="f' + idx + '"></span>';

    function rebuildSubtype(preset, ver) {
      var def = presetDef(preset);
      var spec = def[4];
      var old = row.querySelector('.pnq-nw-subtype, .pnq-nw-subtype-arg');
      var prevVal = old ? old.value : '';
      if (old) old.parentNode.removeChild(old);
      var newEl = null;
      if (spec && spec.arg) {
        newEl = document.createElement('input');
        newEl.type = 'number'; newEl.min = 1; newEl.max = 16777215;
        newEl.className = 'pnq-nw-subtype-arg';
        newEl.placeholder = spec.arg;
        newEl.title = 'Subtype arg (' + spec.arg + ')';
      } else if (spec) {
        newEl = document.createElement('select');
        newEl.className = 'pnq-nw-subtype';
        newEl.title = 'Advanced subtype';
        newEl.innerHTML = subtypeOptions(preset, ver, prevVal) || '';
      }
      if (newEl) {
        // Insert after .pnq-nw-ver
        var verEl = row.querySelector('.pnq-nw-ver');
        verEl.parentNode.insertBefore(newEl, verEl.nextSibling);
      }
    }

    function syncVer() {
      var preset = row.querySelector('.pnq-nw-preset').value;
      var def = presetDef(preset);
      var ver = row.querySelector('.pnq-nw-ver');
      ver.disabled = !def[3];
      ver.style.opacity = def[3] ? '' : '0.4';
      if (!def[3]) ver.value = '';
      // Update v4_only options in subtype select
      var stSel = row.querySelector('.pnq-nw-subtype');
      if (stSel) {
        var ver6 = (ver.value === '6');
        var opts = stSel.querySelectorAll('option');
        for (var i = 0; i < opts.length; i++) {
          var slug = opts[i].value;
          var spec = def[4];
          var isV4only = spec && Array.isArray(spec) &&
            spec.some(function (st) { return st.s === slug && st.v4; });
          opts[i].disabled = !!(ver6 && isV4only);
        }
        if (ver6 && stSel.options[stSel.selectedIndex] && stSel.options[stSel.selectedIndex].disabled) {
          stSel.value = '';
        }
      }
    }

    // 12-swatch colour chip (pnetlab-swatch.js) instead of the native picker
    var colorBtn = row.querySelector('.pnq-nw-color');
    pnqSwatch.attach(colorBtn, f.color || '#ff9800');

    row.querySelector('.pnq-nw-del').addEventListener('click', function () {
      row.parentNode.removeChild(row);
      renumberRows();
      liveReedit();   // Tier 1: re-arm in place if a watch is running
    });
    row.querySelector('.pnq-nw-preset').addEventListener('change', function (ev) {
      var def = presetDef(ev.target.value);
      colorBtn.dataset.color = def[2];
      colorBtn.__pnqSwatchPaint();
      rebuildSubtype(ev.target.value, row.querySelector('.pnq-nw-ver').value);
      syncVer();
    });
    row.querySelector('.pnq-nw-ver').addEventListener('change', syncVer);
    syncVer();
    return row;
  }

  function renumberRows() {
    rows().forEach(function (r, i) {
      r.setAttribute('data-idx', i);
      r.querySelector('.pnq-nw-pps').setAttribute('data-fid', 'f' + i);
    });
  }
  function rows() {
    return Array.prototype.slice.call(panel.querySelectorAll('.pnq-nw-row'));
  }

  function readFilters() {
    return rows().map(function (r) {
      var f = {
        preset: r.querySelector('.pnq-nw-preset').value,
        version: r.querySelector('.pnq-nw-ver').value,
        src_ip: r.querySelector('.pnq-nw-src').value.trim(),
        dst_ip: r.querySelector('.pnq-nw-dst').value.trim(),
        port: r.querySelector('.pnq-nw-port').value.trim(),
        proto: r.querySelector('.pnq-nw-proto').value,
        color: r.querySelector('.pnq-nw-color').dataset.color
      };
      var stSel = r.querySelector('.pnq-nw-subtype');
      if (stSel && stSel.value) f.subtype = stSel.value;
      var stArg = r.querySelector('.pnq-nw-subtype-arg');
      if (stArg && stArg.value) f.subtype_arg = parseInt(stArg.value, 10) || '';
      return f;
    });
  }

  function buildPanel() {
    if (panel) return panel;
    panel = el('div', 'pnq-nw-panel');
    panel.id = 'pnq-nw-panel';
    panel.style.display = 'none';
    panel.innerHTML =
      '<div class="pnq-nw-head"><i class="fa fa-heartbeat"></i> Network Watcher' +
      '<span class="pnq-nw-close" title="Close">&times;</span></div>' +
      '<div class="pnq-nw-body"></div>' +
      '<div class="pnq-nw-foot">' +
      '<button type="button" class="pnq-nw-add">+ filter</button>' +
      '<label class="pnq-nw-speedwrap" title="How often the visuals refresh">Speed ' +
      '<select class="pnq-nw-speed">' + SPEEDS.map(function (s) {
        return '<option value="' + s[0] + '">' + s[1] + '</option>';
      }).join('') + '</select></label>' +
      '<button type="button" class="pnq-nw-startstop">Start</button>' +
      '<span class="pnq-nw-status"></span></div>' +
      '<div class="pnq-nw-note">Watches every link in the lab. Dashes march in the ' +
      'traffic’s direction; hover a lit link for details. Serial links not supported.</div>';
    document.body.appendChild(panel);

    panel.querySelector('.pnq-nw-close').addEventListener('click', function () {
      panel.style.display = 'none';
    });
    panel.querySelector('.pnq-nw-add').addEventListener('click', function () {
      if (rows().length >= MAX_FILTERS) return toast('warning', 'Max ' + MAX_FILTERS + ' filters');
      var used = rows().map(function (r) { return r.querySelector('.pnq-nw-preset').value; });
      var next = PRESETS.filter(function (p) { return used.indexOf(p[0]) < 0; })[0] || PRESETS[0];
      panel.querySelector('.pnq-nw-body').appendChild(
        filterRow({ preset: next[0], color: next[2] }, rows().length));
      renumberRows();
      liveReedit();   // Tier 1: re-arm in place if a watch is running
    });
    // Tier 1 (live re-arm): any field edit (preset/version/subtype/IP/port/proto/
    // colour) while running re-arms the watch in place — no Stop needed. Delegated
    // + debounced so a burst of edits collapses into one re-POST. The broker's
    // linkwatch_start is reload-in-place (Tier 2) / last-start-wins.
    panel.querySelector('.pnq-nw-body').addEventListener('change', function () {
      liveReedit();
    });
    panel.querySelector('.pnq-nw-startstop').addEventListener('click', function () {
      if (state.running) stopWatch(); else startWatch();
    });
    var speedSel = panel.querySelector('.pnq-nw-speed');
    speedSel.value = String(state.speed);
    speedSel.addEventListener('change', function () {
      state.speed = parseFloat(speedSel.value) || 1.0;
      saveSS();
      if (state.running) { startPolling(); startWatch(true); }  // last-start-wins re-spawns at new cadence
    });

    // drag by header
    var head = panel.querySelector('.pnq-nw-head');
    head.addEventListener('mousedown', function (e) {
      if (e.target.classList.contains('pnq-nw-close')) return;
      var sx = e.clientX - panel.offsetLeft, sy = e.clientY - panel.offsetTop;
      function mv(ev) {
        panel.style.left = (ev.clientX - sx) + 'px';
        panel.style.top = (ev.clientY - sy) + 'px';
        panel.style.right = 'auto';
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      e.preventDefault();
    });

    var saved = loadSS();
    var initial = (saved && saved.filters.length) ? saved.filters
      : [{ preset: 'all', color: '#607d8b' }];
    initial.slice(0, MAX_FILTERS).forEach(function (f, i) {
      panel.querySelector('.pnq-nw-body').appendChild(filterRow(f, i));
    });
    return panel;
  }

  function setUiRunning(on, msg) {
    var btn = panel.querySelector('.pnq-nw-startstop');
    btn.textContent = on ? 'Stop' : 'Start';
    btn.classList.toggle('pnq-nw-running', on);
    panel.querySelector('.pnq-nw-status').textContent = msg || '';
    // Tier 1 (live re-arm): filters stay EDITABLE while running — every edit
    // re-arms the watch in place (see liveReedit), so we no longer disable the
    // row controls or the "+ filter" button here.
  }

  /* ── connector mapping ───────────────────────────────────────────────────── */
  function idNum(elId) { var m = /(\d+)$/.exec(elId || ''); return m ? m[1] : null; }
  function isNet(elId) { return /network/i.test(elId || ''); }

  function findConnector(link) {
    var jp = window.lab_topology;
    if (!jp || !jp.getAllConnections) return null;
    var conns = jp.getAllConnections();
    for (var i = 0; i < conns.length; i++) {
      var c = conns[i];
      var sId = c.sourceId || (c.source && c.source.id) || '';
      var tId = c.targetId || (c.target && c.target.id) || '';
      var ok = false, drawnFlip = false;
      if (link.dst && link.dst.network_id != null) {        // node <-> network blob
        ok = (idNum(sId) == link.src.node_id && !isNet(sId) && isNet(tId) && idNum(tId) == link.network_id) ||
             (idNum(tId) == link.src.node_id && !isNet(tId) && isNet(sId) && idNum(sId) == link.network_id);
        drawnFlip = ok && isNet(sId);
      } else {                                               // p2p node <-> node
        ok = !isNet(sId) && !isNet(tId) &&
             ((idNum(sId) == link.src.node_id && idNum(tId) == link.dst.node_id) ||
              (idNum(sId) == link.dst.node_id && idNum(tId) == link.src.node_id));
        drawnFlip = ok && idNum(sId) == link.dst.node_id;
      }
      if (!ok) continue;
      var svg = (c.connector && c.connector.canvas) || c.canvas;
      var base = svg && svg.querySelector && svg.querySelector('path');
      if (!base) return null;
      return { conn: c, svg: svg, base: base, drawnFlip: drawnFlip };
    }
    return null;
  }

  function mapConnectors() {
    state.links.forEach(function (l) {
      var cur = state.conns[l.key];
      // Re-find when we have no connector OR the cached one is STALE: deleting any
      // link makes jsPlumb repaint EVERY connection with fresh SVG elements, so a
      // previously-cached connector's <path> becomes detached (isConnected=false).
      // The old code only re-found on a null entry — a stale-but-truthy entry was
      // kept, leaving every clone frozen on a detached SVG (the whole animation
      // appeared to stop until a manual restart). Detect staleness and rebuild.
      if (cur && cur.base && cur.base.isConnected) return;
      if (state.clones[l.key]) {            // drop clones tied to the dead SVG so
        Object.keys(state.clones[l.key]).forEach(function (k) {   // they rebuild on
          dropClone(l.key, k);                                    // the fresh one
        });
      }
      state.conns[l.key] = findConnector(l);
    });
  }

  /* ── overlays ────────────────────────────────────────────────────────────── */
  // Unit vector perpendicular to the connector (from its endpoints) so each
  // clone can be shifted sideways into its own parallel lane — protocols and
  // the two directions never paint on top of each other.
  function perpOf(baseEl) {
    try {
      var L = baseEl.getTotalLength();
      if (!L) return { x: 0, y: 0 };
      var a = baseEl.getPointAtLength(0), b = baseEl.getPointAtLength(L);
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      return { x: -dy / len, y: dx / len };
    } catch (e) { return { x: 0, y: 0 }; }
  }

  function syncCloneGeometry(linkKey) {
    var m = state.conns[linkKey], set = state.clones[linkKey];
    if (!m || !set) return;
    var d = m.base.getAttribute('d');
    var perp = perpOf(m.base);
    for (var k in set) {
      var p = set[k];
      if (p.getAttribute('d') !== d) p.setAttribute('d', d);
      var lane = p.__lane || 0;
      p.setAttribute('transform', 'translate(' +
        (perp.x * lane * LANE_SP).toFixed(2) + ',' +
        (perp.y * lane * LANE_SP).toFixed(2) + ')');
    }
  }

  // Arrowhead <marker> for a lane, appended to the connector svg's <defs>.
  // One marker per lane (unique id) so each can carry its filter's colour.
  // orient="auto-start-reverse": as marker-end it points along the path; as
  // marker-start it is rotated 180° — i.e. out of the start: '<- - - -'.
  var arrowSeq = 0;
  function laneArrow(m, color) {
    var ns = 'http://www.w3.org/2000/svg';
    var defs = m.svg.querySelector('defs');
    if (!defs) { defs = document.createElementNS(ns, 'defs'); m.svg.insertBefore(defs, m.svg.firstChild); }
    var mk = document.createElementNS(ns, 'marker');
    mk.setAttribute('id', 'pnq-nw-arw-' + (++arrowSeq));
    mk.setAttribute('viewBox', '0 0 10 10');
    mk.setAttribute('refX', '9');
    mk.setAttribute('refY', '5');
    mk.setAttribute('markerWidth', '11');
    mk.setAttribute('markerHeight', '9');
    mk.setAttribute('markerUnits', 'userSpaceOnUse');
    mk.setAttribute('orient', 'auto-start-reverse');
    var tip = document.createElementNS(ns, 'path');
    tip.setAttribute('d', 'M0,0 L10,5 L0,10 z');
    tip.setAttribute('fill', color);
    mk.appendChild(tip);
    defs.appendChild(mk);
    return mk;
  }

  // lane: signed integer — +N forward side, -N reverse side; spreads each
  // filter onto its own track so protocols/directions read as separate bars.
  // reverse means "traffic travels AGAINST the path's drawn direction": the
  // dash march reverses (CSS) and the arrowhead goes on the path START
  // ('<- - - -'); otherwise it goes on the END ('- - - ->').
  function ensureClone(linkKey, key, reverse, color, phase, lane) {
    var m = state.conns[linkKey];
    if (!m) return;
    var set = state.clones[linkKey] || (state.clones[linkKey] = {});
    if (set[key]) return;
    if (Object.keys(set).length >= MAX_CLONES_PER_LINK) return;
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('class', 'pnq-watch-path' + (reverse ? ' pnq-watch-rev' : ''));
    p.setAttribute('d', m.base.getAttribute('d'));
    p.__lane = lane || 0;
    p.style.stroke = color;
    p.style.animationDelay = '-' + (phase * 0.225).toFixed(3) + 's';
    var mk = laneArrow(m, color);
    p.__marker = mk;
    p.setAttribute(reverse ? 'marker-start' : 'marker-end',
                   'url(#' + mk.getAttribute('id') + ')');
    m.svg.appendChild(p);
    set[key] = p;
    if (!m._mo) {
      m._mo = new MutationObserver(function () { syncCloneGeometry(linkKey); });
      m._mo.observe(m.base, { attributes: true, attributeFilter: ['d'] });
    }
    m.svg.classList.add('pnq-watch-lit');
  }

  // busier link → faster dashes (educational: you can see relative rates)
  function marchSpeed(linkKey, key, pps) {
    var set = state.clones[linkKey];
    if (!set || !set[key]) return;
    var dur = pps > 0 ? Math.max(0.3, Math.min(1.3, 4 / pps)) : 0.9;
    set[key].style.animationDuration = dur.toFixed(2) + 's';
  }

  function dropClone(linkKey, key) {
    var set = state.clones[linkKey];
    if (!set || !set[key]) return;
    var mk = set[key].__marker;
    if (mk && mk.parentNode) mk.parentNode.removeChild(mk);
    if (set[key].parentNode) set[key].parentNode.removeChild(set[key]);
    delete set[key];
    if (!Object.keys(set).length) {
      var m = state.conns[linkKey];
      if (m) {
        m.svg.classList.remove('pnq-watch-lit');
        if (m._mo) { m._mo.disconnect(); m._mo = null; }
      }
      delete state.clones[linkKey];
    }
  }

  function clearAllClones() {
    Object.keys(state.clones).forEach(function (lk) {
      Object.keys(state.clones[lk] || {}).forEach(function (k) { dropClone(lk, k); });
    });
    state.clones = {};
  }

  /* ── activation badge ────────────────────────────────────────────────────
     When a lane lights up (traffic newly observed for a link+filter), pop a
     tiny pill over the link's midpoint naming the filter ("CDP",
     "OSPF Hello", "EIGRP Query", "VXLAN VNI 5001"…) tinted with the
     filter's colour, and let it fade out (CSS animation removes it).
     Throttled per (link, filter) so fwd+rev igniting together show once. */
  var BADGE_COOLDOWN = 4;                       // s per (link, filter)
  function hexRgba(hex, a) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 'rgba(60,112,138,' + a + ')';
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function badgeText(f) {
    var def = presetDef(f.preset);
    var t = def[1];
    var spec = def[4];
    if (f.subtype && spec && Array.isArray(spec)) {
      for (var i = 0; i < spec.length; i++) {
        if (spec[i].s === f.subtype) { t += ' ' + spec[i].l; break; }
      }
    } else if (f.subtype_arg && spec && spec.arg) {
      t += ' ' + spec.arg + ' ' + f.subtype_arg;
    }
    return t;
  }
  function showBadge(linkKey, m, f, fi, now) {
    state.badgeTs = state.badgeTs || {};
    var bk = linkKey + '|f' + fi;
    if (state.badgeTs[bk] && (now - state.badgeTs[bk]) < BADGE_COOLDOWN) return;
    state.badgeTs[bk] = now;
    var r;
    try { r = m.base.getBoundingClientRect(); } catch (e) { return; }
    if (!r || (!r.width && !r.height)) return;
    var b = el('div', 'pnq-nw-badge', badgeText(f));
    b.style.background = hexRgba(f.color, 0.16);
    b.style.borderColor = hexRgba(f.color, 0.55);
    b.style.color = f.color;
    // midpoint of the link; stagger per filter index so simultaneous
    // protocols on one link don't overlap
    b.style.left = (r.left + r.width / 2) + 'px';
    b.style.top = (r.top + r.height / 2 - 14 - fi * 20) + 'px';
    document.body.appendChild(b);
    b.addEventListener('animationend', function () { b.remove(); });
    setTimeout(function () { b.remove(); }, 3000);   // belt & braces
  }

  /* ── poll + paint ────────────────────────────────────────────────────────── */
  function applySnapshot(snap) {
    state.snap = snap;
    var now = snap.ts;
    // Refresh connectors up front: a link add/delete repaints jsPlumb and detaches
    // cached connector SVGs; this re-finds the stale ones (and drops their clones)
    // so the animation never freezes on a topology change.
    mapConnectors();
    var totals = {};                                   // fid -> pps sum
    state.links.forEach(function (l) {
      var tapData = (snap.taps || {})[l.tap] || {};
      state.filters.forEach(function (f, i) {
        var fid = 'f' + i;
        var d = tapData[fid] || {};
        var litOut = d.out && d.out.last_ts && (now - d.out.last_ts) < LIT_WINDOW;
        var litIn = d.in && d.in.last_ts && (now - d.in.last_ts) < LIT_WINDOW;
        totals[fid] = (totals[fid] || 0) +
          (litOut ? d.out.pps : 0) + (litIn ? d.in.pps : 0);
        // snapshot "out" = node->net on the watched side; l.flip maps that to
        // the link's src->dst sense, drawnFlip to jsPlumb's path direction
        var fwdLit = l.flip ? litIn : litOut;          // src->dst
        var revLit = l.flip ? litOut : litIn;          // dst->src
        var m = state.conns[l.key];
        if ((fwdLit || revLit) && !m) { mapConnectors(); m = state.conns[l.key]; }
        if (!m) return;
        var drawn = m.drawnFlip;
        var fwdPps = (l.flip ? (d.in || {}).pps : (d.out || {}).pps) || 0;   // src->dst
        var revPps = (l.flip ? (d.out || {}).pps : (d.in || {}).pps) || 0;   // dst->src
        // forward lanes fan out one side (+), reverse lanes the other (−);
        // filter index sets the distance so each protocol gets its own track.
        // activation = a lane that wasn't lit on the previous paint lights up
        var had = state.clones[l.key] || {};
        if ((fwdLit && !had[fid + '_f']) || (revLit && !had[fid + '_r'])) {
          showBadge(l.key, m, f, i, now);
        }
        if (fwdLit) { ensureClone(l.key, fid + '_f', drawn, f.color, i, i + 1); marchSpeed(l.key, fid + '_f', fwdPps); }
        else dropClone(l.key, fid + '_f');
        if (revLit) { ensureClone(l.key, fid + '_r', !drawn, f.color, i + 0.5, -(i + 1)); marchSpeed(l.key, fid + '_r', revPps); }
        else dropClone(l.key, fid + '_r');
      });
      syncCloneGeometry(l.key);
    });
    state.filters.forEach(function (f, i) {
      var sp = panel.querySelector('.pnq-nw-pps[data-fid="f' + i + '"]');
      if (sp) {
        var v = totals['f' + i] || 0;
        sp.textContent = v > 0 ? (Math.round(v * 10) / 10) + ' pps' : '';
        sp.style.color = f.color;
      }
    });
  }

  // Phase 3 (incr 4): push-not-poll. When the lab-state WS path is live the daemon
  // pushes link.state (the SAME /dev/shm/pnet-watch snapshot this overlay polls)
  // into PNQStore, keyed per tap. We then render from a store subscriber (sub-second,
  // one server-side reader fanned out) and the poll SKIPS its own snapshot render
  // below. The poll still runs for the link list + the active/teardown check, and is
  // the automatic fallback the instant the WS path drops (isLive() → false).
  function storeLive() {
    return !!(window.PNQStore && window.PNQLabState &&
              typeof PNQLabState.isLive === 'function' && PNQLabState.isLive());
  }
  // Rebuild applySnapshot's {ts, taps:{<tap>:{f0:{out,in},…}}} shape from the store.
  function snapFromStore() {
    var links = window.PNQStore.state.links, taps = {}, ts = 0;
    for (var k in links) {
      if (!Object.prototype.hasOwnProperty.call(links, k)) continue;
      var e = links[k];
      if (!e) continue;
      taps[k] = e.taps;
      if (e.ts && e.ts > ts) ts = e.ts;
    }
    return { ts: ts || (Date.now() / 1000), taps: taps };
  }
  if (window.PNQStore && typeof PNQStore.subscribe === 'function') {
    PNQStore.subscribe(function (st, changed) {
      if (!state.running || !storeLive()) return;       // off unless watching + WS live
      var hit = false;
      changed.forEach(function (key) { if (key.indexOf('link:') === 0) hit = true; });
      if (hit) applySnapshot(snapFromStore());
    });
  }

  function poll() {
    if (document.hidden) return;
    fetch(URL, { cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.active) {
          // Tear down only after SUSTAINED inactivity, not a single active:false.
          // A self-heal re-arm (linkwatch_start = stop+respawn) briefly has no fresh
          // snapshot; tearing down on the first miss ended the watch on every
          // add/delete. Require ~10s of continuous inactivity (also covers the
          // initial ~1s start gap, so the separate startedAt grace is folded in).
          if (state.running) {
            if (!state.lastActiveTs) state.lastActiveTs = state.startedAt || Date.now();
            if (Date.now() - state.lastActiveTs > 10000) teardown('Watch ended (engine side)');
          }
          return;
        }
        state.lastActiveTs = Date.now();   // engine is live this poll
        // Adopt the resolved link list, and re-adopt when it CHANGES — the server
        // self-heals (re-arms) when a slow node's tap comes up after start (e.g. a
        // docker node), so a new link can appear mid-watch; pick it up so it paints.
        if (j.links && j.links.length) {
          var nk = j.links.map(function (l) { return l.key; }).sort().join('|');
          var ck = (state.links || []).map(function (l) { return l.key; }).sort().join('|');
          if (nk !== ck) state.links = j.links;   // applySnapshot lazily maps new connectors
        }
        // Live WS store path renders via the subscriber above; poll only renders as
        // the fallback (or before the first push arrives).
        if (j.snapshot && !storeLive()) applySnapshot(j.snapshot);
      }).catch(function () {});
  }

  function startPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(poll, pollMs());
    poll();
  }

  function teardown(msg) {
    state.running = false;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    clearAllClones();
    state.links = [];
    state.conns = {};
    saveSS();
    if (panel) setUiRunning(false, msg || '');
  }

  /* ── start / stop ────────────────────────────────────────────────────────── */
  // Tier 1 (live re-arm): re-arm a RUNNING watch in place after a filter edit,
  // debounced so a burst of edits collapses into one re-POST. startWatch(true)
  // keeps the visuals up (last-start-wins / broker reload-in-place). No-op when
  // not running. A brief "filters updated" hint reminds the user counters may
  // reset on the (Tier-1) respawn; Tier 2 preserves them, making it a no-op.
  var _reeditTimer = null;
  function liveReedit() {
    if (!state.running) return;
    if (_reeditTimer) clearTimeout(_reeditTimer);
    _reeditTimer = setTimeout(function () {
      _reeditTimer = null;
      if (!state.running) return;
      startWatch(true);
      var st = panel && panel.querySelector('.pnq-nw-status');
      if (st) st.textContent = 'filters updated';
    }, 250);
  }

  // restart=true: a silent re-arm at a new cadence (speed change) — keep visuals
  function startWatch(restart) {
    var filters = readFilters();
    if (!filters.length) return toast('warning', 'Add at least one filter');
    state.filters = filters;
    var payload = filters.map(function (f) {
      var o = { preset: f.preset };
      if (f.version) o.version = f.version;
      if (f.subtype) o.subtype = f.subtype;
      if (f.subtype_arg) o.subtype_arg = f.subtype_arg;
      if (f.src_ip) o.src_ip = f.src_ip;
      if (f.dst_ip) o.dst_ip = f.dst_ip;
      if (f.port) o.port = parseInt(f.port, 10);
      if (f.proto) o.proto = f.proto;
      return o;
    });
    if (!restart) setUiRunning(true, 'starting…');
    fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', filters: payload, interval: state.speed })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) {
          if (!restart) setUiRunning(false, '');
          var j = res.j || {};
          if (j.error === 'cap_exceeded') {
            return toast('error', 'Too many ' + j.what + ' (' + (j.count || '') +
              ' > max ' + j.max + ') — Network Watcher is capped for performance');
          }
          return toast('error', 'Watch failed: ' + (j.message || j.error || 'unknown'));
        }
        state.running = true;
        state.startedAt = Date.now();
        state.links = res.j.links || [];
        if (!restart) { state.conns = {}; mapConnectors(); }
        saveSS();
        setUiRunning(true, 'watching ' + state.links.length + ' link' +
          (state.links.length === 1 ? '' : 's'));
        startPolling();
      }).catch(function (e) {
        if (!restart) setUiRunning(false, '');
        toast('error', 'Watch failed: ' + e);
      });
  }

  function stopWatch() {
    fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' })
    }).catch(function () {});
    teardown('');
  }

  // reattach after a page reload if the engine-side watch is still running
  function tryReattach() {
    var saved = loadSS();
    if (!saved || !saved.running) return;
    fetch(URL, { cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.active) { state.running = false; saveSS(); return; }
        state.running = true;
        state.filters = saved.filters;
        state.links = j.links || [];
        buildPanel();
        setUiRunning(true, 'watching ' + state.links.length + ' links (reattached)');
        startPolling();
      }).catch(function () {});
  }

  /* ── tooltip ─────────────────────────────────────────────────────────────── */
  var tip = null;
  function tipFor(link) {
    if (!state.snap) return '';
    var tapData = (state.snap.taps || {})[link.tap] || {};
    var name = link.dst.network_id != null
      ? link.src.name + ' ↔ ' + link.dst.name
      : link.src.name + '·' + link.src.iface + ' ↔ ' +
        link.dst.name + '·' + link.dst.iface;
    var lines = ['<b>' + name + '</b>'];
    state.filters.forEach(function (f, i) {
      var d = tapData['f' + i] || {};
      var o = d.out || {}, n = d.in || {};
      if (!o.total && !n.total) return;
      var fwd = link.flip ? n : o, rev = link.flip ? o : n;
      var label = PRESETS.filter(function (p) { return p[0] === f.preset; })[0];
      lines.push('<span style="color:' + f.color + '">●</span> ' +
        (label ? label[1] : f.preset) +
        ' → ' + (fwd.pps || 0) + ' pps · ← ' + (rev.pps || 0) + ' pps' +
        ((fwd.last || rev.last) ? '<br><small>' + (fwd.last || rev.last) + '</small>' : ''));
    });
    return lines.length > 1 ? lines.join('<br>') : '';
  }

  function installTooltip() {
    if (tip) return;
    tip = el('div', 'pnq-nw-tip');
    tip.style.display = 'none';
    document.body.appendChild(tip);
    document.addEventListener('mousemove', function (e) {
      if (!state.running) { tip.style.display = 'none'; return; }
      var svg = e.target && e.target.closest && e.target.closest('svg.jtk-connector');
      if (!svg || !svg.classList.contains('pnq-watch-lit')) {
        tip.style.display = 'none';
        return;
      }
      var link = null;
      for (var i = 0; i < state.links.length; i++) {
        var m = state.conns[state.links[i].key];
        if (m && m.svg === svg) { link = state.links[i]; break; }
      }
      var html = link ? tipFor(link) : '';
      if (!html) { tip.style.display = 'none'; return; }
      tip.innerHTML = html;
      tip.style.display = 'block';
      tip.style.left = (e.clientX + 14) + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
    }, { passive: true });
  }

  /* ── sidebar entry ───────────────────────────────────────────────────────── */
  function inject() {
    if (document.getElementById('pnq-netwatch')) return true;
    var ul = document.querySelector('#lab-sidebar ul');
    if (!ul) return false;
    var li = el('li');
    li.id = 'pnq-netwatch';
    li.innerHTML = '<a href="javascript:void(0)" title="Visualise matching traffic on the topology links">' +
      '<i class="fa fa-heartbeat"></i><span class="lab-sidebar-title">Network Watcher</span></a>';
    li.querySelector('a').addEventListener('click', function () {
      buildPanel();
      panel.style.display = panel.style.display === 'none' ? '' : 'none';
    });
    var anchor = document.getElementById('pnq-fixperm');
    if (anchor && anchor.parentNode === ul) ul.insertBefore(li, anchor);
    else ul.appendChild(li);
    return true;
  }

  function init() {
    installTooltip();
    tryReattach();
    if (inject()) return;
    var mo = new MutationObserver(function () { if (inject()) mo.disconnect(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
