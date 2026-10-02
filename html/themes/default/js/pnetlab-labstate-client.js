/*
 * pnetlab-labstate-client.js — lab-page live-state push client (Tier A, Phase 1).
 *
 * Opens ONE multiplexed wss connection to /labstate/ (proxied to the localhost
 * pnetlab-labstated daemon) and pushes node status onto the topology in real time,
 * so the page no longer depends on the per-client nodestatus poll for liveness.
 *
 * Design notes:
 *  - CSP-clean by construction: a same-origin classic script, fetch() + WebSocket
 *    only (both already allowed: connect-src 'self' wss: ws:). No eval/new Function.
 *  - ADDITIVE / fail-open: the existing nodestatus poll is left running untouched.
 *    If the socket is unavailable (daemon down, old box, proxy lane missing) the
 *    page behaves exactly as before — this only accelerates updates. The poll is
 *    not removed until javascript.js is under source control (a later phase).
 *  - Auth: mint a single-use token from the session-gated pnq-labstate-token.php,
 *    then hello with it. Re-mint on every (re)connect (tokens are single-use).
 *  - Public API window.PNQLabState: .on(channel, cb) / .subscribe(ch) / .isLive()
 *    so later overlays (Network Watcher, Inspector) can consume link.state without
 *    their own polls.
 */
(function () {
  "use strict";

  if (window.PNQ_LABSTATE_WS === false) return;     // hard kill-switch
  if (window.PNQLabState) return;                   // singleton

  var TOKEN_URL = "/pnq-labstate-token.php";
  var SUBS = ["node.state", "link.state"];           // node status + live link traffic
  var listeners = {};                               // channel -> [cb]
  var ws = null;
  var live = false;
  var stopped = false;
  var backoff = 1000;                               // ms, grows to BACKOFF_MAX
  var BACKOFF_MAX = 15000;
  var reconnectTimer = null;
  // Heartbeat liveness: the socket can handshake then stall silently behind the
  // proxy (isLive() stayed true, no deltas arrived → LEDs/cables went stale until
  // a reload). Ping on an interval; every inbound frame (incl. pong) refreshes
  // lastActivityAt, and isLive() treats a socket with no traffic for STALE_MS as
  // dead so the status poll (functions/status/render.js) resumes as the fail-safe.
  var lastActivityAt = 0;                           // ms epoch of the last inbound frame
  var heartbeatTimer = null;
  var PING_MS = 10000;                              // ping cadence
  var STALE_MS = 25000;                             // no traffic this long ⇒ not live (2+ missed pongs)

  function emit(channel, payload) {
    var cbs = listeners[channel];
    if (!cbs) return;
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](payload); } catch (e) { /* a bad listener never kills the bus */ }
    }
  }

  /* ---- node status -> topology (mirrors functions.js printLabStatus .done) ---- */
  function applyStatusToTopology(node_id, status) {
    if (!(window.App && App.topology && App.topology.nodes)) return;
    var entry = App.topology.nodes[node_id];
    if (!entry || typeof entry.get !== "function") return;
    var nodeComp = entry.get("component", false);
    if (!nodeComp) return;
    if (nodeComp.attr("data-status") == 5) return;       // transient/locked: leave it
    nodeComp.attr("data-status", status);
    if (window.nodes && window.nodes[node_id]) window.nodes[node_id]["status"] = status;
  }

  // Route a node.state push into the store (single source of truth). If the store
  // isn't present (it loads first, so this is just belt-and-suspenders), fall back
  // to applying directly so liveness never depends on the store being loaded.
  function ingestNodeState(nodes) {
    if (!nodes) return;
    if (window.PNQStore) {
      var patch = {};
      for (var id in nodes) {
        if (Object.prototype.hasOwnProperty.call(nodes, id)) patch[id] = { status: nodes[id] };
      }
      PNQStore.apply({ nodes: patch });
    } else {
      for (var nid in nodes) {
        if (Object.prototype.hasOwnProperty.call(nodes, nid)) applyStatusToTopology(nid, nodes[nid]);
      }
    }
  }

  // The topology renderer is a STORE SUBSCRIBER: it derives the view from the
  // store, so every feeder (WS push now, the nodestatus poll later) flows through
  // one place. This is the cure for DOM-as-state.
  if (window.PNQStore) {
    PNQStore.subscribe(function (state, changed) {
      changed.forEach(function (key) {
        if (key.indexOf("node:") !== 0) return;
        var id = key.slice(5);
        var n = state.nodes[id];
        if (n && typeof n.status !== "undefined") applyStatusToTopology(id, n.status);
      });
    });
  }

  // link.state -> store (keyed per tap/link-end). Only flows when a Network Watcher
  // watch is running; harmless no-op otherwise. Overlays can subscribe to "link:*"
  // changes to derive live per-link traffic from the store instead of polling.
  function ingestLinkState(msg) {
    if (!msg || !msg.taps || !window.PNQStore) return;
    var patch = {};
    for (var tap in msg.taps) {
      if (Object.prototype.hasOwnProperty.call(msg.taps, tap)) {
        patch[tap] = { ts: msg.ts, watch_id: msg.watch_id, taps: msg.taps[tap] };
      }
    }
    PNQStore.apply({ links: patch });
  }

  function labSession() {
    return (typeof LAB !== "undefined" && LAB) ? LAB : null;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  }

  function connect() {
    if (stopped) return;
    if (!labSession()) { scheduleReconnect(); return; }   // no lab open yet — retry

    // Single-use token first; cookie rides along (same-origin).
    fetch(TOKEN_URL, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (j) {
        if (!j || !j.token) return Promise.reject("no token");
        openSocket(j.token);
      })
      .catch(function (reason) {
        // 401/403 = the session cookie is dead (logged out / expired elsewhere).
        // A dead session never recovers on its own, so stop the reconnect loop
        // for good and let the page's own auth/redirect handle it — otherwise
        // this fetch would retry every ~15s forever (the WS-401 spin). Any other
        // failure (network blip, 5xx, timeout, bad token JSON) is transient, so
        // keep the existing backoff-retry behavior.
        if (reason === 401 || reason === 403) { stopped = true; return; }
        scheduleReconnect();
      });
  }

  function openSocket(token) {
    var proto = (location.protocol === "https:") ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/labstate/";
    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      ws.send(JSON.stringify({ t: "hello", token: token }));
    };

    ws.onmessage = function (ev) {
      lastActivityAt = Date.now();                   // any inbound frame (incl. pong) = alive
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      switch (msg.t) {
        case "hello.ok":
          live = true;
          backoff = 1000;                            // reset on a good handshake
          ws.send(JSON.stringify({ t: "sub", ch: SUBS }));
          startHeartbeat();
          emit("open", msg);
          break;
        case "pong":
          break;                                     // liveness only — lastActivityAt already bumped
        case "node.state":
          ingestNodeState(msg.nodes);
          emit("node.state", msg);
          break;
        case "link.state":
          ingestLinkState(msg);
          emit("link.state", msg);
          break;
        case "err":
          // bad token / no lab: drop and let the backoff re-mint
          break;
      }
    };

    ws.onclose = function () {
      live = false;
      ws = null;
      stopHeartbeat();
      emit("close", null);
      scheduleReconnect();
    };

    ws.onerror = function () {
      try { ws.close(); } catch (e) { /* onclose handles reconnect */ }
    };
  }

  // Ping on a cadence; if the socket has produced no inbound frame for STALE_MS
  // (pings unanswered), it has silently stalled — drop it so onclose reconnects,
  // and isLive() already reports false in the meantime so the poll covers the gap.
  function startHeartbeat() {
    stopHeartbeat();
    lastActivityAt = Date.now();
    heartbeatTimer = setInterval(function () {
      if (!ws) return;
      if (Date.now() - lastActivityAt > STALE_MS) {
        try { ws.close(); } catch (e) { /* onclose reconnects */ }
        return;
      }
      try { ws.send(JSON.stringify({ t: "ping" })); } catch (e) { /* next tick / onclose */ }
    }, PING_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  /* ---- public bus ---------------------------------------------------------- */
  window.PNQLabState = {
    on: function (channel, cb) {
      (listeners[channel] = listeners[channel] || []).push(cb);
      return this;
    },
    subscribe: function (ch) {
      if (SUBS.indexOf(ch) === -1) SUBS.push(ch);
      if (live && ws) ws.send(JSON.stringify({ t: "sub", ch: [ch] }));
      return this;
    },
    // Heartbeat-backed: a handshook-but-stalled socket (no inbound frame for
    // STALE_MS) reports NOT live, so functions/status/render.js resumes polling.
    isLive: function () { return live && (Date.now() - lastActivityAt) < STALE_MS; },
    stop: function () {
      stopped = true;
      stopHeartbeat();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { try { ws.close(); } catch (e) {} }
    }
  };

  // The page (and LAB) come up via deferred scripts; kick off once the DOM is
  // ready and let connect() retry until a lab session exists.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connect);
  } else {
    connect();
  }
})();
