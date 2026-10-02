/**
 * pnetlab-node-stats.js — fills the Nodes modal's live "CPU %" / "RAM Used" cells.
 *
 * While the Nodes modal (.configured-nodes) is open, poll /pnq-nodestats.php
 * (per-node {cpu:%, mem:MB} for the current lab) and paint the usage bars in the
 * cells createNodeListRow() laid out (td.pnq-usage-cell[data-nid][data-kind]).
 * Polling starts when the table appears and stops when the modal closes. Fail-safe:
 * any error just leaves the cells as "—".
 */
(function () {
  'use strict';

  var URL = '/pnq-nodestats.php';
  var INTERVAL = 3000;
  var timer = null;

  function tableOpen() { return document.querySelector('.configured-nodes'); }

  function paint(data) {
    var cells = document.querySelectorAll('.configured-nodes .pnq-usage-cell');
    Array.prototype.forEach.call(cells, function (td) {
      var nid = td.getAttribute('data-nid');
      var kind = td.getAttribute('data-kind');
      var bar = td.querySelector('.pnq-usage-bar > i');
      var val = td.querySelector('.v');
      var d = data && data[nid];
      if (!d) { if (val) val.textContent = '—'; if (bar) bar.style.width = '0%'; td.classList.remove('on'); return; }
      if (kind === 'cpu') {
        var c = parseInt(d.cpu, 10) || 0;
        if (val) val.textContent = c + '%';
        if (bar) bar.style.width = Math.max(0, Math.min(100, c)) + '%';
        td.classList.toggle('on', c > 0);
        td.classList.toggle('hot', c >= 85);
      } else {
        var m = parseInt(d.mem, 10) || 0;
        var max = parseInt(td.getAttribute('data-max'), 10) || 0;
        if (val) val.textContent = m > 0 ? (m + ' MB') : '—';
        if (bar) bar.style.width = (max > 0 ? Math.max(0, Math.min(100, m * 100 / max)) : (m > 0 ? 100 : 0)) + '%';
        td.classList.toggle('on', m > 0);
        td.classList.toggle('hot', max > 0 && m >= max * 0.9);
      }
    });
  }

  // Re-sync each row's running/greyed state to the node's LIVE status (window.nodes
  // is kept current by the engine's nodestatus poll). When a node is stopped from
  // inside the modal its inputs become editable again; when started, they lock.
  function syncRowStates() {
    var lock = (typeof LOCK !== 'undefined') ? LOCK : 0;
    var rows = document.querySelectorAll('.configured-nodes tbody tr');
    Array.prototype.forEach.call(rows, function (tr) {
      var cell = tr.querySelector('.pnq-usage-cell[data-nid]');
      if (!cell) return;
      var nid = cell.getAttribute('data-nid');
      var running = (window.nodes && window.nodes[nid] && (window.nodes[nid].status | 0) === 2);
      if (tr.classList.contains('pnq-node-running') === !!running) return;   // unchanged
      tr.classList.toggle('pnq-node-running', !!running);
      var disable = running || (lock != 0);
      Array.prototype.forEach.call(tr.querySelectorAll('input, select'), function (el) { el.disabled = disable; });
    });
  }

  function poll() {
    if (!tableOpen()) { stop(); return; }
    syncRowStates();
    fetch(URL, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (tableOpen()) paint(j && j.data); })
      .catch(function () {});
  }

  function start() { if (timer) return; poll(); timer = setInterval(poll, INTERVAL); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // watch for the Nodes modal opening/closing
  function init() {
    if (tableOpen()) start();
    new MutationObserver(function () {
      if (tableOpen()) start(); else stop();
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
