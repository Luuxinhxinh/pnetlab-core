/*
 * pnetlab-notif-history.js — notification COUNT PILL + "Message History" panel.
 *
 * Wraps window.addMessage (functions/core/dom.js) so every toast is ALSO pushed
 * into a capped in-memory session buffer ({sev,text,ts}, newest first, last 100).
 * Renders a persistent PILL in the top-right lab chrome — REPLACING the legacy
 * #alert_container "Notifications" header (functions/status/render.js), which the
 * stylesheet hides so there is a SINGLE persistent notification widget. The pill
 * shows per-severity colored count badges + a total; clicking it toggles a
 * "Message History" popover: header + trash (clear) + close, scrollable
 * newest-first rows with a severity dot, message text and a localized timestamp,
 * faintly tinted per severity. The transient toasts (#notification_container) are
 * untouched and continue to fade — they are shifted down to sit below the pill.
 *
 * Severity mapping mirrors addMessage: danger=red, success=green, info=blue,
 * warning/alert=amber; anything else counts as info. Transient toasts are left
 * completely untouched (the wrapper always delegates to the original).
 *
 * z-order: pill at 100050, panel at 100090 — above the canvas + all legacy
 * chrome/modals, just BELOW the island overlay portal (100100) and the toast band
 * (100200), so real modals and toasts always paint over the popover. CSP-safe.
 */
(function () {
  'use strict';

  var CAP = 100;
  var PILL_ID = 'pnq-nh-pill';
  var PANEL_ID = 'pnq-nh-panel';
  var SEVS = ['success', 'danger', 'info', 'warning'];

  var store = window.PNQNotifHistory = window.PNQNotifHistory || { items: [] };

  function normSev(s) {
    s = String(s || '').toLowerCase();
    if (s === 'danger' || s === 'error') return 'danger';
    if (s === 'success') return 'success';
    if (s === 'warning' || s === 'alert') return 'warning';
    return 'info';
  }

  // toast messages may carry markup — keep only the text for the history rows
  function stripHtml(html) {
    var d = document.createElement('div');
    d.innerHTML = String(html == null ? '' : html);
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function push(sev, message) {
    store.items.unshift({ sev: normSev(sev), text: stripHtml(message), ts: Date.now() });
    if (store.items.length > CAP) store.items.length = CAP;
    renderPill();
    if (isOpen()) renderList();
  }

  /* ---- hook addMessage (defined by functions/core/dom.js via the transition
     shim; classic defer order puts it before this addon, but keep a retry so a
     load-order change can never silently lose the hook) ---- */
  function hook() {
    var fn = window.addMessage;
    if (typeof fn !== 'function' || fn.__pnqNotifWrapped) return typeof fn === 'function';
    var wrapped = function (severity, message, notFromLabviewport) {
      try { push(severity, message); } catch (e) { /* history must never break toasts */ }
      return fn.apply(this, arguments);
    };
    wrapped.__pnqNotifWrapped = true;
    window.addMessage = wrapped;
    return true;
  }
  if (!hook()) {
    var tries = 0;
    var t = setInterval(function () { if (hook() || ++tries > 80) clearInterval(t); }, 250);
  }

  /* ---- count pill (lives in the quickbar next to the action buttons) ---- */
  function counts() {
    var c = { success: 0, danger: 0, info: 0, warning: 0 };
    for (var i = 0; i < store.items.length; i++) c[store.items[i].sev]++;
    return c;
  }

  function renderPill() {
    var b = document.getElementById(PILL_ID);
    if (!b) return;
    var c = counts(), total = store.items.length, html = '';
    for (var i = 0; i < SEVS.length; i++) {
      if (c[SEVS[i]]) html += '<span class="pnq-nh-badge pnq-nh-' + SEVS[i] + '">' + c[SEVS[i]] + '</span>';
    }
    html += '<span class="pnq-nh-total' + (total ? '' : ' pnq-nh-zero') + '">' + total + '</span>';
    b.innerHTML = '<i class="glyphicon glyphicon-bell" aria-hidden="true"></i>' + html;
    b.title = 'Message History (' + total + ')';
    b.setAttribute('aria-label', 'Message History, ' + total + ' messages');
  }

  // Persistent top-right pill. It REPLACES the legacy #alert_container
  // "Notifications" header (render.js printPageLabOpen) — that box is hidden by
  // the stylesheet, and this pill takes its top-right spot. Body-level fixed so
  // it is NOT tied to the hideable quickbar; mounts once the lab page
  // (#pnq-lab-page) exists so it never shows on the pre-open loading screen.
  function ensurePill() {
    if (document.getElementById(PILL_ID)) return;
    if (!document.getElementById('pnq-lab-page')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.id = PILL_ID;
    b.setAttribute('aria-haspopup', 'true');
    b.addEventListener('click', function (ev) { ev.stopPropagation(); toggle(); });
    document.body.appendChild(b);
    renderPill();
  }

  /* ---- Message History panel ---- */
  function isOpen() {
    var p = document.getElementById(PANEL_ID);
    return !!(p && p.style.display !== 'none');
  }

  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString(); }
    catch (e) { return '' + ts; }
  }

  function renderList() {
    var list = document.getElementById('pnq-nh-list');
    if (!list) return;
    list.textContent = '';
    if (!store.items.length) {
      var empty = document.createElement('div');
      empty.className = 'pnq-nh-empty';
      empty.textContent = 'No messages yet.';
      list.appendChild(empty);
      return;
    }
    for (var i = 0; i < store.items.length; i++) {
      var it = store.items[i];
      var row = document.createElement('div');
      row.className = 'pnq-nh-row pnq-nh-row-' + it.sev;
      var dot = document.createElement('span');
      dot.className = 'pnq-nh-dot pnq-nh-' + it.sev;
      var txt = document.createElement('span');
      txt.className = 'pnq-nh-text';
      txt.textContent = it.text;
      var tm = document.createElement('span');
      tm.className = 'pnq-nh-time';
      tm.textContent = fmtTime(it.ts);
      row.appendChild(dot); row.appendChild(txt); row.appendChild(tm);
      list.appendChild(row);
    }
  }

  function ensurePanel() {
    var p = document.getElementById(PANEL_ID);
    if (p) return p;
    p = document.createElement('div');
    p.id = PANEL_ID;
    p.style.display = 'none';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Message History');

    var head = document.createElement('div');
    head.className = 'pnq-nh-head';
    var title = document.createElement('span');
    title.className = 'pnq-nh-title';
    title.textContent = 'Message History';
    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'pnq-nh-iconbtn';
    clear.id = 'pnq-nh-clear';
    clear.title = 'Clear history';
    clear.setAttribute('aria-label', 'Clear history');
    clear.innerHTML = '<i class="glyphicon glyphicon-trash" aria-hidden="true"></i>';
    clear.addEventListener('click', function (ev) {
      ev.stopPropagation();
      store.items.length = 0;
      renderPill();
      renderList();
    });
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'pnq-nh-iconbtn';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '&times;';
    close.addEventListener('click', function (ev) { ev.stopPropagation(); hide(); });
    head.appendChild(title); head.appendChild(clear); head.appendChild(close);

    var list = document.createElement('div');
    list.id = 'pnq-nh-list';

    p.appendChild(head); p.appendChild(list);
    p.addEventListener('click', function (ev) { ev.stopPropagation(); });
    document.body.appendChild(p);
    return p;
  }

  function place(p) {
    var b = document.getElementById(PILL_ID);
    var w = 340;
    p.style.width = w + 'px';
    if (b) {
      var r = b.getBoundingClientRect();
      var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
      p.style.left = left + 'px';
      p.style.top = (r.bottom + 10) + 'px';
    } else {
      p.style.left = ((window.innerWidth - w) / 2) + 'px';
      p.style.top = '64px';
    }
  }

  function show() {
    var p = ensurePanel();
    renderList();
    p.style.display = 'block';
    place(p);
  }
  function hide() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.style.display = 'none';
  }
  function toggle() { if (isOpen()) hide(); else show(); }

  document.addEventListener('click', function (ev) {
    if (!isOpen()) return;
    var p = document.getElementById(PANEL_ID);
    if (p && !p.contains(ev.target)) hide();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && isOpen()) hide();
  });
  window.addEventListener('resize', function () {
    if (isOpen()) place(document.getElementById(PANEL_ID));
  });

  function init() {
    ensurePill();
    // the quickbar can render late / rebuild on lab open — keep trying.
    new MutationObserver(ensurePill).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
