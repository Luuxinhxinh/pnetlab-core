// pnetlab-capture-console.js
// Route the node right-click "Capture" (Wireshark) into the NEW web console's
// HTTP lane instead of the legacy Guacamole HTML5 modal.
//
// The lab UI's capture menu items call a GLOBAL onclick="wireshark_capture(node,
// iface)" (defined in the React lab bundle). We override that global so a capture:
//   1. ensures the wireshark record exists      -> POST /api/labs/session/wireshark/add
//   2. creates the Capture_<id> container       -> POST /api/labs/session/wireshark/capture
//      (image pnet-capture-web; engine-side, serving its UI over HTTP on :80)
//   3. adds the capture to ONE aggregated "Captures" window (captures.html),
//      whose sidebar doubles as the tab strip (each entry labelled
//      SRC node·port -> DST node·port). Each capture runs in its OWN iframe
//      (console.html?capture=1&node&iface) where token_mint.php (capture mode)
//      looks the container up in the wiresharks table and mints an HTTP-lane token
//      to ws_ip:80. Each entry can be popped out into its own window.
//
// LANE NOTE (corrected 2026-08-05): this used to be the VNC/guacamole-lite lane —
// a token to ws_ip:5900 against the old pnet-wireshark image. That is retired.
// token_mint.php:101-123 resolves the capture to the pnet-capture-web container's
// HTTP UI and writes the same grant the node http-console lane writes, so it is
// proxied by http_ws_bridge.py (:8025) via /console/http/<token>/;
// token_mint.php:193-195 now hard-fails a legacy ?type=rdp&capture=1 with 409.
// The bridge is therefore a HARD dependency of capture: when it was crash-looping
// on a missing `httpx`, every capture rendered Apache's 503 page (see
// docs/eve-parity-roadmap.md, Wave 9 / R3). The NATIVE html5-off local-Wireshark
// lane (console/capture_native.php) is entirely separate and unaffected.
//
// Additive, self-contained (registered in themes/default/index.html); no edits to
// the minified engine code. The override is installed via a property getter/setter
// so it wins regardless of when the React bundle assigns wireshark_capture.
(function () {
  'use strict';

  // ?v bump forces browsers to drop the cached captures.html. sc5 = tab close
  // tears the capture container down (teardown'd 'closed' broadcast).
  // (no left sidebar) + per-tab pop-out; the inner console.html tab bar is hidden
  // in capture mode so there's a single set of tabs.
  var CAPTURES_URL = '/console/captures.html?v=748c1137';
  var activeCaptures = new Map();        // key -> desc (for replay to the window)
  // Persist active captures so they survive a page refresh: the capture containers
  // keep running engine-side, so on reload we reload the descriptors and the
  // restored Captures window's hello->replay repopulates (each iframe reconnects).
  var CAP_KEY = 'pnq_captures_v1';       // sessionStorage
  function saveCaptures() {
    try { sessionStorage.setItem(CAP_KEY, JSON.stringify(Array.from(activeCaptures.values()))); } catch (e) {}
  }
  (function loadCaptures() {
    try {
      var raw = sessionStorage.getItem(CAP_KEY); if (!raw) return;
      var list = JSON.parse(raw); if (!Array.isArray(list)) return;
      list.forEach(function (d) { if (d && d.key) activeCaptures.set(d.key, d); });
    } catch (e) {}
  })();
  var capBC = ('BroadcastChannel' in window) ? new BroadcastChannel('pnq-captures') : null;
  var capClosingTimer = null;                            // grace timer (close-vs-refresh)
  if (capBC) {
    capBC.onmessage = function (e) {
      var m = e.data; if (!m) return;
      if (m.type === 'hello') {                          // window (re)loaded -> resend
        // A reload re-announces, so it was a refresh, not a close: cancel any
        // pending window-close teardown before it evicts the live captures.
        if (capClosingTimer) { clearTimeout(capClosingTimer); capClosingTimer = null; }
        replayCaptures();
      }
      else if (m.type === 'window-closing') {
        // The captures window is unloading (close OR refresh). Wait a short grace;
        // a refresh fires 'hello' on reload (cancelling this), a real close does
        // not — so we then stop+remove every still-active capture container.
        if (capClosingTimer) clearTimeout(capClosingTimer);
        capClosingTimer = setTimeout(function () {
          capClosingTimer = null;
          activeCaptures.forEach(function (d, key) {
            var node = d && d.node, iface = d && d.iface;
            if (node == null) {                          // descriptor lost -> parse the key
              var km = /^cap-(\d+)-(\d+)$/.exec(key);
              if (km) { node = km[1]; iface = km[2]; }
            }
            if (node != null) post('/api/labs/session/wireshark/delete',
                                   { node_id: node, interface_id: iface });
          });
          activeCaptures.clear(); saveCaptures();
        }, 3000);
      }
      else if (m.type === 'closed' && m.key) {
        // m.teardown: the user clicked the tab's ✕ in the captures window —
        // stop+remove the capture container engine-side (wireshark/delete),
        // otherwise it keeps running and dumpcap accumulates packets forever.
        // Relaunch-eviction 'closed' messages (sent by THIS side, no teardown
        // flag) never reach here: BroadcastChannel doesn't echo to the sender.
        var d = activeCaptures.get(m.key);
        activeCaptures.delete(m.key); saveCaptures();
        if (m.teardown) {
          var node = d && d.node, iface = d && d.iface;
          if (node == null) {                       // descriptor lost (e.g. reload race)
            var km = /^cap-(\d+)-(\d+)$/.exec(m.key);
            if (km) { node = km[1]; iface = km[2]; }
          }
          if (node != null) post('/api/labs/session/wireshark/delete',
                                 { node_id: node, interface_id: iface });
        }
      }
      // Shared desktop: raise the clicked capture's Wireshark window (xdotool).
      else if (m.type === 'focus' && m.node != null) {
        post('/api/labs/session/wireshark/focus', { node_id: m.node, interface_id: m.iface });
      }
    };
  }
  function replayCaptures() {
    if (!capBC || !activeCaptures.size) return;
    try { capBC.postMessage({ type: 'replay', list: Array.from(activeCaptures.values()) }); } catch (e) {}
  }
  function ensureCapturesWindow() {
    if (typeof window.pnqOpenConsoleWindow === 'function')
      // ~30% bigger than the default 760x520 console window (Wireshark needs room).
      window.pnqOpenConsoleWindow(CAPTURES_URL, 'captures', 'Captures', { width: '988px', height: '676px' });
    else
      window.open(CAPTURES_URL, 'pnet-captures');
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  function fail(msg) {
    if (typeof error_handle === 'function') { try { error_handle({ message: msg }); return; } catch (e) {} }
    if (typeof addModalError === 'function') { try { addModalError(msg); return; } catch (e) {} }
    alert(msg);
  }

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); });
  }
  // Normalize the interfaces API payload to a list of ethernet entries
  // ({id,name,network_id}); tolerate array or id-keyed object shapes.
  function ethList(d) {
    if (!d) return [];
    var e = d.ethernet || d.ethernets || d;
    if (Array.isArray(e)) return e;
    if (e && typeof e === 'object') return Object.keys(e).map(function (k) {
      var o = e[k] || {}; if (o.id == null) o.id = k; return o;
    });
    return [];
  }

  // Build "SRC node·port -> DST node·port" from the live topology. SRC is the
  // captured node+interface; DST is the peer sharing the interface's network_id
  // (a point-to-point link has exactly one peer; a real network/bridge -> "net<id>").
  // Best-effort: any failure degrades to node/iface ids.
  function resolveCaptureLabel(nodeId, ifaceId) {
    return fetchJson('/api/labs/session/nodes').then(function (nj) {
      var list = (nj && nj.data) || {}; var nmap = {}; var ids = [];
      Object.keys(list).forEach(function (k) {
        var n = list[k] || {}; var id = String(n.id != null ? n.id : k);
        nmap[id] = n.name || ('node' + id); ids.push(id);
      });
      return Promise.all(ids.map(function (id) {
        return fetchJson('/api/labs/session/interfaces?node_id=' + encodeURIComponent(id))
          .then(function (r) { return { id: id, eth: ethList(r && r.data) }; })
          .catch(function () { return { id: id, eth: [] }; });
      })).then(function (all) {
        var byNode = {}; all.forEach(function (x) { byNode[x.id] = x.eth; });
        var srcEth = byNode[String(nodeId)] || [];
        var srcIf = srcEth.filter(function (e) { return String(e.id) === String(ifaceId); })[0]
                 || srcEth[Number(ifaceId)] || null;
        var srcPort = (srcIf && srcIf.name) ? srcIf.name : ('e' + ifaceId);
        var src = (nmap[String(nodeId)] || ('node' + nodeId)) + ' ' + srcPort;
        var dst = '';
        var net = srcIf && (srcIf.network_id != null ? srcIf.network_id : srcIf.networkId);
        if (net != null && net !== '' && String(net) !== '0') {
          var peers = [];
          ids.forEach(function (id) {
            (byNode[id] || []).forEach(function (e) {
              var en = (e.network_id != null ? e.network_id : e.networkId);
              if (String(en) === String(net) && !(String(id) === String(nodeId) && String(e.id) === String(ifaceId)))
                peers.push({ node: nmap[id] || ('node' + id), port: e.name || '' });
            });
          });
          if (peers.length === 1) dst = peers[0].node + (peers[0].port ? (' ' + peers[0].port) : '');
          else if (peers.length > 1) dst = 'net' + net;
        }
        return { src: src, dst: dst };
      });
    }).catch(function () { return { src: 'node' + nodeId + ' if' + ifaceId, dst: '' }; });
  }

  // The actual capture launcher: create the container, then add it to the
  // aggregated Captures window.
  function captureToConsole(nodeId, ifaceId) {
    var key = 'cap-' + nodeId + '-' + ifaceId;
    // Evict any stale entry for this slot BEFORE the API calls so that the
    // captures window drops the old iframe (old container) before the new one
    // is ready.  The server always restarts the container fresh.
    if (activeCaptures.has(key)) {
      activeCaptures.delete(key);
      saveCaptures();
      if (capBC) try { capBC.postMessage({ type: 'closed', key: key }); } catch (e) {}
    }
    var data = { node_id: nodeId, interface_id: ifaceId };
    // add (idempotent: allocates the wiresharks row) -> capture (restarts container fresh)
    post('/api/labs/session/wireshark/add', data)
      .then(function () { return post('/api/labs/session/wireshark/capture', data); })
      .then(function (res) {
        if (res && res.status && res.status !== 'success') {
          fail((res.message && res.message.message) || res.message || 'Capture failed');
          return;
        }
        return resolveCaptureLabel(nodeId, ifaceId).then(function (lbl) {
          var name = lbl.dst ? (lbl.src + ' → ' + lbl.dst) : lbl.src;
          // Render the capture over VNC via the web console's guacamole-lite:
          // console.html?capture=1 -> token_mint.php capture lane -> guacd dials the
          // pnet-wireshark container's ws_ip:5900. (Each capture is its own container
          // + its own iframe, so streams are naturally separate — no shared desktop.)
          var url = '/console/console.html?capture=1'
            + '&node=' + encodeURIComponent(nodeId)
            + '&iface=' + encodeURIComponent(ifaceId)
            + '&name=' + encodeURIComponent(name);
          var desc = { key: key, node: String(nodeId), iface: String(ifaceId),
                       src: lbl.src, dst: lbl.dst, name: name, url: url };
          activeCaptures.set(key, desc);
          saveCaptures();
          ensureCapturesWindow();
          if (capBC) {
            try { capBC.postMessage({ type: 'add', desc: desc }); } catch (e) {}
            // window may still be loading on the very first capture; add() is
            // idempotent and the window's hello->replay also covers the race.
            setTimeout(function () { try { capBC.postMessage({ type: 'add', desc: desc }); } catch (e) {} }, 800);
          }
        });
      })
      .catch(function (e) { fail('Capture failed: ' + (e && e.message ? e.message : e)); });
  }

  // Install as window.wireshark_capture, surviving the React bundle's own
  // assignment: keep the engine impl in _real (fallback) but always serve ours.
  var _real = window.wireshark_capture;
  try {
    Object.defineProperty(window, 'wireshark_capture', {
      configurable: true,
      get: function () { return capture; },
      set: function (fn) { _real = fn; },   // swallow the engine's reassignment
    });
  } catch (e) {
    window.wireshark_capture = capture;       // best-effort fallback
  }

  function capture(nodeId, ifaceId) {
    try { captureToConsole(nodeId, ifaceId); }
    catch (e) { if (typeof _real === 'function') _real(nodeId, ifaceId); else fail('Capture error'); }
  }

  window.pnqCaptureToConsole = captureToConsole;  // direct entry point if needed
})();
