/**
 * pnetlab-link-hide.js — hide / reveal individual topology links.
 *
 *   • Right-click a link → "Hide link": removes that link's line + interface
 *     labels from the canvas (the nodes stay). Persisted per-lab in localStorage,
 *     so it survives redraws and reloads.
 *   • Quickbar "Hidden Links" button: toggles between HIDDEN (links gone) and
 *     REVEALED (hidden links drawn SHADED + dashed). The button shows the hidden
 *     count and lights up while revealing.
 *   • While revealed, CLICK a shaded link (its line or label) to UNHIDE just that
 *     one link.
 *
 * Pure view layer — no engine/lab-file change. A link is keyed by its network id
 * (connection id "network_id:N"), so a point-to-point cable (one network = one
 * link) hides cleanly; a shared segment hides as a unit. Mirrors the additive,
 * redraw-safe overlay pattern of pnetlab-canvas-nav.js / pnetlab-egress-glow.js.
 */
(function () {
  'use strict';

  var reveal = false;                 // false = hidden links are gone; true = shaded
  var DEBUG = true;                   // logs to console with [pnq-linkhide] prefix
  function dbg() { if (!DEBUG) return; try { console.log.apply(console, ['[pnq-linkhide]'].concat([].slice.call(arguments))); } catch (e) {} }

  /* ── persistence: SERVER-side, keyed by the open lab ───────────────────────────
   * The authoritative store is /pnq-linkhide.php (keyed by the lab the session has
   * open) — so a refresh, a different browser, or another user all see the same
   * hidden links, with none of the client-side lab-key guessing that kept losing the
   * state. localStorage is only a fast offline fallback. `hidden` is the in-memory
   * working copy. */
  var hidden = new Set();             // in-memory working copy (network-id strings)
  var FALLBACK_KEY = 'pnq_hidden_links';
  function saveLocal() {
    try { localStorage.setItem(FALLBACK_KEY, JSON.stringify(Array.from(hidden))); } catch (e) {}
  }
  function loadLocal() {
    try { var raw = localStorage.getItem(FALLBACK_KEY); if (raw) return new Set(JSON.parse(raw).map(String)); } catch (e) {}
    return new Set();
  }
  // Pull the authoritative list from the server (the lab is identified by the
  // session cookie) and apply it.
  function serverLoad() {
    fetch('/pnq-linkhide.php', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.hidden) {
          hidden = new Set(j.hidden.map(String));
          saveLocal();
          dbg('server load:', hidden.size, 'hidden link(s)');
          apply();
          notifyIsland(); // Wave 7 fix 6a — sync the island to the authoritative set
        }
      }).catch(function () { dbg('server load failed — using localStorage fallback'); });
  }
  // Persist to the server (authoritative) and localStorage (fallback).
  function persist() {
    saveLocal();
    fetch('/pnq-linkhide.php', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: Array.from(hidden) })
    }).then(function (r) { dbg('saved', hidden.size, 'link(s) to server', r && r.ok ? 'ok' : 'FAILED'); })
      .catch(function () { dbg('server save failed — kept in localStorage'); });
  }

  /* ── jsPlumb connection helpers (same API as egress-glow) ──────────────────── */
  function allConns() {
    var jp = window.lab_topology;
    return (jp && jp.getAllConnections) ? jp.getAllConnections() : [];
  }
  function connNet(c) {
    var id = (c && c.id) || '';
    var m = /network_id:(\d+)/.exec(id);
    return m ? m[1] : null;
  }
  function connSvg(c) { return (c && ((c.connector && c.connector.canvas) || c.canvas)) || null; }
  function eachOverlayCanvas(c, fn) {
    if (!c || !c.getOverlays) return;
    var ovs = c.getOverlays();
    for (var oid in ovs) { var oc = ovs[oid] && ovs[oid].canvas; if (oc) fn(oc); }
  }

  function setConn(c, mode) {                        // mode: 'hidden' | 'shaded' | 'normal'
    var svg = connSvg(c);
    if (mode === 'hidden') {
      if (c.setVisible) { try { c.setVisible(false); } catch (e) {} }
      else if (svg) svg.style.display = 'none';
      return;
    }
    if (c.setVisible) { try { c.setVisible(true); } catch (e) {} }
    if (svg) {
      svg.style.display = '';
      svg.classList.toggle('pnq-link-shaded', mode === 'shaded');
    }
    eachOverlayCanvas(c, function (oc) {
      oc.style.display = '';
      if (oc.classList) oc.classList.toggle('pnq-link-shaded', mode === 'shaded');
    });
  }

  /* ── apply the hidden/reveal state to every connection ─────────────────────── */
  var _dbgSig = '';
  function apply() {
    var conns = allConns(), nets = [], applied = 0;
    conns.forEach(function (c) {
      var n = connNet(c);
      if (n == null) return;
      nets.push(n);
      if (hidden.has(n)) { setConn(c, reveal ? 'shaded' : 'hidden'); applied++; }
      else setConn(c, 'normal');
    });
    // log only when the picture changes (avoid 1/s spam from the watchdog)
    var sig = hidden.size + '|' + applied + '|' + nets.join(',') + '|' + reveal;
    if (DEBUG && sig !== _dbgSig) {
      _dbgSig = sig;
      dbg('apply: hidden=', Array.from(hidden),
          '| connection net-ids=', nets, '| applied=', applied, '| reveal=', reveal);
    }
    updateButton();
  }
  var applyT = null;
  function applySoon() { if (applyT) return; applyT = setTimeout(function () { applyT = null; apply(); }, 120); }

  /* ── island bridge (Wave 7 fix 6a) ─────────────────────────────────────────
   * Notify the canvas-flow island of any hide/unhide/reveal change so it can keep
   * its own edge set in sync (recompute hidden edges + reveal parity) without a
   * reload. CSP-safe: a plain CustomEvent dispatch, no inline/eval. Carries the
   * current hidden network-id list + the reveal flag. The island (mounted only
   * with ?canvas=flow) listens for pnq:linkhide-changed; on a normal page nothing
   * listens and this is a cheap no-op. */
  function notifyIsland() {
    try {
      document.dispatchEvent(new CustomEvent('pnq:linkhide-changed', {
        detail: { hidden: Array.from(hidden), reveal: reveal }
      }));
    } catch (e) {}
  }

  /* ── hide / unhide actions ─────────────────────────────────────────────────── */
  function hideLink(net) { hidden.add(String(net)); persist(); apply(); notifyIsland(); }
  function unhideLink(net) { hidden.delete(String(net)); persist(); apply(); notifyIsland(); }

  /* Direct toggle for the canvas-flow island (Wave 1 / b2 A4). The island already
   * knows the link's network id from its own PNQStore-derived model, so it drives
   * hide/unhide by netId directly — no jsPlumb window.connToDel scaffold + observer
   * round-trip. persist() + apply() + notifyIsland() run exactly as the menu lane,
   * so the server + localStorage mirror + the island's pnq:linkhide-changed repaint
   * all fire identically. Returns the new hidden state. */
  window.pnqLinkHideToggle = function (net, willHide) {
    if (net == null) return null;
    var n = String(net);
    var target = (typeof willHide === 'boolean') ? willHide : !hidden.has(n);
    if (target) hideLink(n); else unhideLink(n);
    return hidden.has(n);
  };

  // map a clicked SVG/overlay element back to its link's network id
  function netOfEl(el) {
    var conns = allConns();
    for (var i = 0; i < conns.length; i++) {
      var c = conns[i], svg = connSvg(c), hit = (svg && (svg === el || svg.contains(el)));
      if (!hit) eachOverlayCanvas(c, function (oc) { if (oc === el || oc.contains(el)) hit = true; });
      if (hit) return connNet(c);
    }
    return null;
  }

  /* ── reveal toggle: click a shaded link to unhide it ───────────────────────── */
  document.addEventListener('click', function (e) {
    if (!reveal) return;
    var el = e.target.closest && e.target.closest('.jtk-connector, .jtk-overlay');
    if (!el) return;
    var net = netOfEl(el);
    if (net != null && hidden.has(net)) {
      e.preventDefault(); e.stopPropagation();
      unhideLink(net);
    }
  }, true);

  /* ── "Hide link" item in the link right-click menu ─────────────────────────── */
  function injectMenu(menu) {
    if (!menu || menu.dataset.pnqHideInjected) return;
    // a LINK menu carries Delete (action-conndelete) and/or Edit (action-connectedit)
    var del = menu.querySelector('.action-conndelete');
    var edit = menu.querySelector('.action-connectedit');
    if (!del && !edit) return;
    // the right-clicked connection is window.connToDel; only network-backed links
    var cid = (window.connToDel && window.connToDel.id) || '';
    var m = /network_id:(\d+)/.exec(cid);
    if (!m) return;
    menu.dataset.pnqHideInjected = '1';
    var net = m[1];
    // A hidden link can be right-clicked while it's revealed (shaded) — offer to
    // unhide it; otherwise offer to hide it.
    var isHidden = hidden.has(net);
    var li = document.createElement('li');
    li.innerHTML = '<a class="action-pnq-hidelink" href="javascript:void(0)">' +
      '<i class="fa ' + (isHidden ? 'fa-eye' : 'fa-eye-slash') + '"></i> ' +
      (isHidden ? 'Unhide link' : 'Hide link') + '</a>';
    li.querySelector('a').addEventListener('click', function (ev) {
      ev.preventDefault();
      if (isHidden) unhideLink(net); else hideLink(net);
      var cm = document.getElementById('context-menu'); if (cm) cm.remove();
    });
    var delLi = del ? del.closest('li') : null;
    if (delLi && delLi.parentNode) delLi.parentNode.insertBefore(li, delLi);
    else (menu.querySelector('ul, .dropdown-menu') || menu).appendChild(li);
  }

  /* ── quickbar button: toggle reveal ────────────────────────────────────────── */
  function toggleReveal() { reveal = !reveal; apply(); notifyIsland(); }
  function updateButton() {
    var b = document.getElementById('pnq-hidelink-btn'); if (!b) return;
    var n = hidden ? hidden.size : 0;
    b.classList.toggle('pnq-btn-active', reveal);
    b.style.display = '';                                   // always available
    var i = b.querySelector('i'); if (i) i.className = 'fa ' + (reveal ? 'fa-eye' : 'fa-eye-slash');
    var lbl = b.querySelector('.pnq-label');
    var text = n > 0 ? ('Hidden Links (' + n + ')') : 'Hidden Links';
    if (lbl) lbl.textContent = text;
    b.setAttribute('aria-label', text);
  }
  function ensureButton() {
    var bar = document.getElementById('pnq-buttons');
    if (!bar || document.getElementById('pnq-hidelink-btn')) return;
    // Pass 1 a11y hardening: real <button> (was a div) for Tab/Enter/Space.
    var b = document.createElement('button');
    b.type = 'button';
    b.id = 'pnq-hidelink-btn';
    b.className = 'pnq-btn';
    b.title = 'Show hidden links (shaded) — then click a shaded link to unhide it';
    b.innerHTML = '<i class="fa fa-eye-slash" aria-hidden="true"></i><span class="pnq-label">Hidden Links</span>';
    b.addEventListener('click', toggleReveal);
    bar.appendChild(b);
    updateButton();
  }

  function injectStyle() {
    if (document.getElementById('pnq-link-hide-style')) return;
    var st = document.createElement('style');
    st.id = 'pnq-link-hide-style';
    st.textContent =
      // shaded (revealed-but-hidden) link: faint, dashed, a touch thicker so it's
      // easy to click to unhide; its label dims to match.
      '.jtk-connector.pnq-link-shaded path{opacity:.38 !important;stroke-dasharray:5 4 !important;' +
      'stroke-width:2.5px !important;cursor:pointer}' +
      '.jtk-connector.pnq-link-shaded:hover path{opacity:.85 !important}' +
      '.jtk-overlay.pnq-link-shaded{opacity:.5 !important;cursor:pointer}' +
      '.jtk-overlay.pnq-link-shaded:hover{opacity:.95 !important}' +
      '#pnq-hidelink-btn.pnq-btn-active{background:rgba(216,162,58,.30);' +
      'box-shadow:inset 0 0 0 1px rgba(216,162,58,.7)}';
    document.head.appendChild(st);
  }

  /* ── boot ──────────────────────────────────────────────────────────────────── */
  function init() {
    injectStyle();
    ensureButton();
    // re-apply on canvas redraws (node move / zoom / printTopology rebuild) and
    // keep the quickbar button + menu hooks alive as the lab view rebuilds.
    var mo = new MutationObserver(function (muts) {
      var touch = false;
      for (var i = 0; i < muts.length; i++) {
        for (var j = 0; j < muts[i].addedNodes.length; j++) {
          var n = muts[i].addedNodes[j];
          if (n.nodeType !== 1) continue;
          if (n.id === 'context-menu') injectMenu(n);
          else if (n.querySelector) { var cm = n.querySelector('#context-menu'); if (cm) injectMenu(cm); }
          if ((n.classList && n.classList.contains('jtk-connector')) ||
              (n.querySelector && n.querySelector('.jtk-connector'))) touch = true;
        }
      }
      if (!document.getElementById('pnq-hidelink-btn')) ensureButton();
      if (touch) applySoon();
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // Seed from the localStorage fallback immediately (so a hide shows instantly even
    // before the network round-trip), then pull the authoritative list from the server
    // (identified by the session) and re-apply. Retry a couple of times in case the
    // session/lab isn't ready the instant this script runs.
    hidden = loadLocal();
    serverLoad();
    setTimeout(serverLoad, 1500);
    setTimeout(serverLoad, 4000);

    // Watchdog: a heavy lab (many vIOS nodes) can finish — or RE-run — its React
    // topology render well after load, recreating connections as visible. Re-assert
    // the hidden state if any hidden link is currently showing. Cheap + idempotent
    // (a handful of connections), and self-heals regardless of render timing, so a
    // refresh reliably restores hidden links. No-op once everything is in sync.
    // Re-asserts the in-memory hidden set against the live connections.
    setInterval(function () {
      if (!hidden.size) return;
      var conns = allConns();
      for (var i = 0; i < conns.length; i++) {
        var n = connNet(conns[i]); if (n == null || !hidden.has(n)) continue;
        var svg = connSvg(conns[i]); if (!svg) continue;
        var showing = svg.style.display !== 'none';
        var shaded = svg.classList && svg.classList.contains('pnq-link-shaded');
        // drift: hidden link visible while not revealing, or shaded-state mismatch
        if ((!reveal && showing) || (reveal && !shaded)) { apply(); return; }
      }
    }, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
