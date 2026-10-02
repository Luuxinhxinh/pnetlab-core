/**
 * pnetlab-node-rename.js — "Rename" in the node right-click menu.
 *
 * The node context menu is built by the minified lab.js, so — like
 * pnetlab-node-duplicate.js / pnetlab-shape.js — we watch for #context-menu
 * landing in the DOM and inject a "Rename" item into the single-node menu.
 *
 * There is no dedicated rename API; the engine's edit endpoint
 * (/api/labs/session/nodes/edit) accepts a partial update, and the page
 * already exposes updateNodeData(id, data) which merges window.nodes[id] with
 * the partial and POSTs it, then refreshes the topology. So a rename is just
 * updateNodeData(id, { name: <new> }).
 *
 * UX: a small Apple-glass inline prompt anchored at the cursor (no big modal),
 * pre-filled with the current name, Enter to commit / Esc to cancel — matching
 * the lightweight feel of pnetlab-text.js. Whitespace is trimmed; an empty or
 * unchanged name is a no-op.
 *
 * Self-contained injected module (loaded by themes/default/index.html), same
 * pattern as pnetlab-node-duplicate.js. White Apple-glass palette, accent #3c708a.
 */
(function () {
  'use strict';

  var ACCENT = '#3c708a';

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  // Current display name for a node id, from the live topology model.
  function currentName(id) {
    try {
      if (window.nodes && window.nodes[id] && window.nodes[id].name != null)
        return String(window.nodes[id].name);
    } catch (_) {}
    return '';
  }

  // Commit the rename through the engine's existing edit path.
  function applyRename(id, name) {
    name = (name || '').trim();
    if (!name || name === currentName(id)) return;
    if (typeof updateNodeData === 'function') {
      updateNodeData(id, { name: name });
    } else if (typeof addMessage === 'function') {
      addMessage('error', 'Rename unavailable: updateNodeData() missing.');
    }
  }

  // Small glass prompt anchored near (x,y). cb(value) on commit.
  function openPrompt(x, y, initial, cb) {
    var OLD = document.getElementById('pnq-rename-pop');
    if (OLD) OLD.remove();

    var pop = el('div'); pop.id = 'pnq-rename-pop';
    pop.style.cssText =
      'position:fixed;z-index:100000;min-width:230px;padding:12px;' +
      'background:rgba(255,255,255,0.92);backdrop-filter:saturate(180%) blur(20px);' +
      '-webkit-backdrop-filter:saturate(180%) blur(20px);' +
      'border:1px solid rgba(0,0,0,0.10);border-radius:12px;' +
      'box-shadow:0 12px 40px rgba(0,0,0,0.22);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    var lbl = el('div', null, 'Rename node');
    lbl.style.cssText = 'color:#1d1d1f;font-size:13px;font-weight:600;margin-bottom:8px;letter-spacing:-.01em;';

    var inp = el('input');
    inp.type = 'text'; inp.value = initial || '';
    // The body.pnq-dark input[type=text] global in
    // assets-common/css/pnetlab-enhance-v2.css:4965-4974 uses !important;
    // preserve this prompt's intentionally white-glass field in both themes.
    inp.style.cssText =
      'width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid rgba(0,0,0,0.16) !important;' +
      'border-radius:8px;background:#fff !important;color:#1d1d1f !important;font-size:13px;font-family:inherit;outline:none;';
    inp.addEventListener('focus', function () { inp.style.setProperty('border-color', ACCENT, 'important'); });
    inp.addEventListener('blur', function () { inp.style.setProperty('border-color', 'rgba(0,0,0,0.16)', 'important'); });

    var row = el('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px;';
    function mkBtn(text, primary) {
      var b = el('button', null, text);
      b.type = 'button';
      b.style.cssText = primary
        ? 'padding:6px 16px;background:' + ACCENT + ';color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;font-family:inherit;'
        : 'padding:6px 13px;background:rgba(0,0,0,0.06);color:#1d1d1f;border:1px solid rgba(0,0,0,0.13);border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit;';
      return b;
    }
    var btnCancel = mkBtn('Cancel', false);
    var btnSave = mkBtn('Rename', true);
    row.append(btnCancel, btnSave);

    pop.append(lbl, inp, row);
    document.body.appendChild(pop);

    // keep on-screen
    var r = pop.getBoundingClientRect();
    var px = Math.min(x, window.innerWidth - r.width - 12);
    var py = Math.min(y, window.innerHeight - r.height - 12);
    pop.style.left = Math.max(8, px) + 'px';
    pop.style.top = Math.max(8, py) + 'px';

    function close() {
      document.removeEventListener('mousedown', onAway, true);
      pop.remove();
    }
    function commit() { var v = inp.value; close(); cb(v); }
    function onAway(e) { if (!pop.contains(e.target)) close(); }

    btnCancel.addEventListener('click', close);
    btnSave.addEventListener('click', commit);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    document.addEventListener('mousedown', onAway, true);

    inp.focus(); inp.select();
  }

  // Inject "Rename" into the single-node context menu (skip the group menu).
  function injectMenu(menu) {
    if (!menu || menu.dataset.pnqRename) return;
    var edit = menu.querySelector('a.action-nodeedit[data-path]');
    if (!edit) return;                                   // single-node menus only
    menu.dataset.pnqRename = '1';

    var id = edit.getAttribute('data-path');
    var li = el('li');
    li.innerHTML = '<a class="action-rename" data-path="' + id + '" href="javascript:void(0)">' +
      '<i class="glyphicon glyphicon-pencil"></i> Rename</a>';

    // place it directly above "Edit" (Edit opens the full node form; Rename is
    // the quick name-only path right next to it)
    var editLi = edit.closest('li');
    if (editLi && editLi.parentNode) editLi.parentNode.insertBefore(li, editLi);
    else menu.querySelector('ul, .dropdown-menu').appendChild(li);

    // the menu height grew after printContextMenu() measured it — pull up if it
    // now overflows the bottom (same fix as pnetlab-node-duplicate.js)
    var screenH = (document.getElementById('body') || document.documentElement).offsetHeight || window.innerHeight;
    var overflow = menu.getBoundingClientRect().bottom - screenH;
    if (overflow > 0) {
      var curTop = parseInt(menu.style.top, 10) || 0;
      menu.style.top = Math.max(0, curTop - overflow) + 'px';
    }
  }

  // capture-phase click so the menu's own handlers don't fire first
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('.action-rename');
    if (!t) return;
    e.preventDefault(); e.stopImmediatePropagation();
    var id = t.getAttribute('data-path');
    // anchor the prompt where the menu was (fall back to viewport centre)
    var cm = document.getElementById('context-menu');
    var ax = window.innerWidth / 2, ay = window.innerHeight / 2;
    if (cm) { var cr = cm.getBoundingClientRect(); ax = cr.left; ay = cr.top; cm.remove(); }
    openPrompt(ax, ay, currentName(id), function (name) { applyRename(id, name); });
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
