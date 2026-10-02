/**
 * pnetlab-sat-badge.js — paints a small airplane (✈) marker on the top-right of
 * every canvas node that runs on a satellite, as an at-a-glance "this node is
 * remote" cue. Cluster-only: on a single-host lab the endpoint returns nothing
 * and no markers appear.
 *
 * Design (mirrors pnetlab-egress-glow.js):
 *  • Polls /pnq-placements.php every 7 s (skips when document.hidden) for
 *    {nodes:{node_id: host_id}} of satellite-hosted nodes.
 *  • Appends a .pnq-sat-badge <div> (Font Awesome fa-plane) to #node<id>; the
 *    node div is an absolute/relative positioning context so the badge anchors
 *    to its top-right corner. pointer-events:none so it never blocks drag/click.
 *  • Removes markers for nodes that are no longer on a satellite (moved/stopped).
 */
/* global $ */

(function () {
  'use strict';

  var POLL_MS  = 7000;
  var STYLE_ID = 'pnq-sat-badge-style';

  (function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '.pnq-sat-badge{' +
        'position:absolute;top:-7px;right:-7px;z-index:60;' +
        'width:17px;height:17px;line-height:17px;text-align:center;' +
        'font-size:10px;border-radius:50%;' +
        'background:#2d6cdf;color:#fff;' +
        'border:1px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.45);' +
        'pointer-events:none;}' +
      '.pnq-sat-badge i{line-height:inherit;}';
    (document.head || document.documentElement).appendChild(s);
  }());

  function apply(map) {                       // map = {node_id: host_id}
    // Drop markers that are no longer satellite-hosted.
    var existing = document.querySelectorAll('.pnq-sat-badge');
    for (var i = 0; i < existing.length; i++) {
      var nid = existing[i].getAttribute('data-nid');
      if (!map || !(nid in map)) existing[i].remove();
    }
    if (!map) return;
    Object.keys(map).forEach(function (nid) {
      var el = document.getElementById('node' + nid);
      if (!el) return;
      // ensure a positioning context without disturbing canvas placement
      // (canvas nodes are position:absolute, which already qualifies)
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      var b = el.querySelector('.pnq-sat-badge');
      if (!b) {
        b = document.createElement('div');
        b.className = 'pnq-sat-badge';
        b.setAttribute('data-nid', nid);
        b.innerHTML = '<i class="fa fa-plane"></i>';
        el.appendChild(b);
      }
      b.title = 'Running on Satellite ' + map[nid];
    });
  }

  function poll() {
    if (document.hidden) return;
    fetch('/pnq-placements.php', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.nodes) apply(d.nodes); })
      .catch(function () {});
  }

  function init() { setInterval(poll, POLL_MS); poll(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
