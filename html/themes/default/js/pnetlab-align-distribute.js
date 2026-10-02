/**
 * pnetlab-align-distribute.js — "Distribute Horizontally / Vertically" for a
 * multi-node selection.
 *
 * PNetLab already ships align actions in the multi-select group menu
 * (action-halign-group / valign-group / calign-group / autoalign-group in
 * actions.js). What's missing is *distribute* — even spacing across a selection.
 * This injects two items into the same group menu and implements them.
 *
 * Distribute keeps the two extreme objects fixed and evenly spaces the centres
 * of the ones in between (needs ≥3 selected). It operates on every .ui-selected
 * object (nodes, networks, shapes) and reuses the app's own coordinate math and
 * persistence path (ObjectPosUpdate → ObjectPosUpdateExec) exactly like the
 * built-in align handlers, so positions save and the topology repaints.
 *
 * Injected the same way as pnetlab-node-duplicate.js / pnetlab-bulk-node-edit.js:
 * watch #context-menu into the DOM and add to the group menu only.
 */
(function () {
  'use strict';

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function msg(kind, text) { if (typeof window.addMessage === 'function') window.addMessage(kind, text); }

  // Read each selected object's unzoomed centre + size, mirroring actions.js
  // align handlers (position() is transform-scaled → divide by zoom; outerWidth
  // is layout px → unzoomed). css top/left are written in unzoomed lab coords.
  function collect() {
    var $ = window.jQuery;
    var zoom = (typeof getZoomLab === 'function' ? getZoomLab() : 100) / 100; if (!zoom) zoom = 1;
    var items = [];
    $('.ui-selected').each(function () {
      var $e = $(this);
      var w = Math.round($e.outerWidth(true)), h = Math.round($e.outerHeight(true));
      items.push({
        $e: $e, w: w, h: h,
        cx: Math.round($e.position().left / zoom) + w / 2,
        cy: Math.round($e.position().top / zoom) + h / 2
      });
    });
    return items;
  }

  function distribute(axis, e) {
    var $ = window.jQuery; if (!$) return;
    var items = collect();
    if (items.length < 3) { msg('warning', 'Select 3 or more objects to distribute.'); return; }
    var horiz = (axis === 'h');
    items.sort(function (a, b) { return horiz ? a.cx - b.cx : a.cy - b.cy; });
    var n = items.length;
    var first = horiz ? items[0].cx : items[0].cy;
    var last = horiz ? items[n - 1].cx : items[n - 1].cy;
    for (var i = 1; i < n - 1; i++) {
      var target = first + (last - first) * i / (n - 1);
      if (horiz) items[i].$e.css({ left: Math.round(target - items[i].w / 2) });
      else items[i].$e.css({ top: Math.round(target - items[i].h / 2) });
      if (window.lab_topology && window.lab_topology.revalidate) {
        try { window.lab_topology.revalidate(items[i].$e); } catch (_) {}
      }
    }
    // persist + repaint via the app's own path (same as the align handlers)
    if (typeof ObjectPosUpdate === 'function') {
      ObjectPosUpdate(e, function () { if (window.App && App.topology) App.topology.printTopology(); });
    } else if (window.App && App.topology) {
      App.topology.printTopology();
    }
  }

  function injectMenu(menu) {
    if (!menu || menu.dataset.pnqDistribute) return;
    if (menu.querySelector('a.action-nodeedit[data-path]')) return;     // single-node menu → skip
    var groupAnchor = menu.querySelector('a[class*="-group"]');
    if (!groupAnchor) return;                                           // not a group menu
    menu.dataset.pnqDistribute = '1';

    var liH = el('li');
    liH.innerHTML = '<a class="action-distribute-h" href="javascript:void(0)">' +
      '<i class="glyphicon glyphicon-resize-horizontal"></i> Distribute Horizontally</a>';
    var liV = el('li');
    liV.innerHTML = '<a class="action-distribute-v" href="javascript:void(0)">' +
      '<i class="glyphicon glyphicon-resize-vertical"></i> Distribute Vertically</a>';

    // place right after the vertical-align item if present, else after the first
    // group action
    var anchor = menu.querySelector('a.action-valign-group') ||
                 menu.querySelector('a.action-halign-group') || groupAnchor;
    var anchorLi = anchor && anchor.closest('li');
    if (anchorLi && anchorLi.parentNode) {
      anchorLi.parentNode.insertBefore(liV, anchorLi.nextSibling);
      anchorLi.parentNode.insertBefore(liH, anchorLi.nextSibling);
    } else {
      var ul = menu.querySelector('ul, .dropdown-menu');
      if (ul) { ul.appendChild(liH); ul.appendChild(liV); }
    }

    // menu grew after printContextMenu() measured it — pull up if it overflows
    var screenH = (document.getElementById('body') || document.documentElement).offsetHeight || window.innerHeight;
    var overflow = menu.getBoundingClientRect().bottom - screenH;
    if (overflow > 0) {
      var curTop = parseInt(menu.style.top, 10) || 0;
      menu.style.top = Math.max(0, curTop - overflow) + 'px';
    }
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('.action-distribute-h, .action-distribute-v');
    if (!t) return;
    e.preventDefault(); e.stopImmediatePropagation();
    var cm = document.getElementById('context-menu'); if (cm) cm.remove();
    distribute(t.classList.contains('action-distribute-h') ? 'h' : 'v', e);
  }, true);

  function init() {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        for (var j = 0; j < muts[i].addedNodes.length; j++) {
          var n = muts[i].addedNodes[j];
          if (n.nodeType !== 1) continue;
          var menu = (n.id === 'context-menu') ? n : (n.querySelector && n.querySelector('#context-menu'));
          if (menu) injectMenu(menu);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
