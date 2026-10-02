/**
 * pnetlab-image-store.js — "Image Store" for the PNetLab topology page.
 *
 * Adds a quickbar button that opens a white Apple-glass modal (styled to match
 * the Add Node picker) for browsing and downloading QEMU / IOL images from the
 * ishare2 / LabHub catalog straight into their addon paths. Talks to the local
 * backend at /ishare2/api.php (catalog / download / status).
 */
(function () {
  'use strict';

  var API = '/ishare2/api.php';
  var state = { loaded: false, tab: 'qemu', q: '', data: { qemu: [], iol: [] }, jobs: {}, changed: false };

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function api(qs) { return fetch(API + qs, { credentials: 'same-origin' }).then(function (r) { return r.json(); }); }

  /* ── quickbar button ─────────────────────────────────────────────────────── */
  function injectButton() {
    var bar = document.getElementById('pnq-buttons');
    if (!bar || document.getElementById('pnq-images-btn')) return;
    // Pass 1 a11y hardening: real <button> (was a div) so the button is
    // Tab-reachable and Enter/Space-activatable, matching the static
    // quickbar buttons in index.html.
    var btn = el('button', 'pnq-btn pnq-images-btn',
      '<i class="glyphicon glyphicon-cloud-download" aria-hidden="true"></i><span class="pnq-label">Images</span>');
    btn.type = 'button';
    btn.id = 'pnq-images-btn';
    btn.setAttribute('aria-label', 'Images');
    var toggle = document.getElementById('pnq-toggle');
    if (toggle && toggle.parentNode === bar) bar.insertBefore(btn, toggle); else bar.appendChild(btn);
    btn.addEventListener('click', openStore);
  }

  /* ── modal ───────────────────────────────────────────────────────────────── */
  function ensureModal() {
    if (document.getElementById('pnq-store-overlay')) return;
    var ov = el('div', 'pnq-store-overlay'); ov.id = 'pnq-store-overlay';
    var modal = el('div', 'pnq-store-modal pnq-node-modal');
    // fa (not glyphicon): the main/store pages run Bootstrap 4, which dropped
    // glyphicons — font-awesome is loaded everywhere this modal can open.
    modal.innerHTML =
      '<div class="pnq-store-head">' +
        '<span class="pnq-store-title"><i class="fa fa-cloud-download"></i> Image Store</span>' +
        '<span class="pnq-store-sub" id="pnq-store-sub"></span>' +
        '<button class="pnq-store-x" id="pnq-store-x">&times;</button>' +
      '</div>' +
      '<div class="pnq-store-body">' +
        '<div class="pnq-store-left">' +
          '<div class="pnq-store-tabs">' +
            '<button class="pnq-store-tab pnq-active" data-tab="qemu">QEMU</button>' +
            '<button class="pnq-store-tab" data-tab="iol">IOL</button>' +
          '</div>' +
          '<input type="text" class="pnq-store-search" id="pnq-store-search" placeholder="Search images…" autocomplete="off">' +
          '<label class="pnq-store-onlymissing"><input type="checkbox" id="pnq-store-missing"> Hide installed</label>' +
          '<div class="pnq-store-hint">Images download straight to their addon path. Large files can take a while — you can keep working.</div>' +
        '</div>' +
        '<div class="pnq-store-right">' +
          '<div class="pnq-store-count" id="pnq-store-count"></div>' +
          '<div class="pnq-store-list" id="pnq-store-list"></div>' +
        '</div>' +
      '</div>';
    ov.appendChild(modal);
    document.body.appendChild(ov);

    ov.addEventListener('click', function (e) { if (e.target === ov) closeStore(); });
    modal.querySelector('#pnq-store-x').addEventListener('click', closeStore);
    modal.querySelectorAll('.pnq-store-tab').forEach(function (t) {
      t.addEventListener('click', function () {
        modal.querySelectorAll('.pnq-store-tab').forEach(function (x) { x.classList.remove('pnq-active'); });
        t.classList.add('pnq-active'); state.tab = t.dataset.tab; renderList();
      });
    });
    var s = modal.querySelector('#pnq-store-search');
    s.addEventListener('input', function () { state.q = s.value.trim().toLowerCase(); renderList(); });
    modal.querySelector('#pnq-store-missing').addEventListener('change', renderList);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.getElementById('pnq-store-overlay').classList.contains('pnq-open')) closeStore();
    });
  }

  function openStore() {
    ensureModal();
    document.getElementById('pnq-store-overlay').classList.add('pnq-open');
    if (!state.loaded) loadCatalog(); else renderList();
  }
  function closeStore() {
    var ov = document.getElementById('pnq-store-overlay');
    if (ov) ov.classList.remove('pnq-open');
    // PNetLab caches the template/image list at page load, so a freshly
    // installed (or deleted) image won't appear in the Add Node modal until a
    // reload. If anything changed this session, reload the topology page so the
    // new images are picked up. (Only when changed — browsing never reloads.)
    if (state.changed) { state.changed = false; window.location.reload(); }
  }

  function loadCatalog() {
    var list = document.getElementById('pnq-store-list');
    list.innerHTML = '<div class="pnq-store-loading">Loading catalog…</div>';
    api('?action=catalog').then(function (d) {
      if (d.error) { list.innerHTML = '<div class="pnq-store-err">' + d.error + '</div>'; return; }
      state.data = { qemu: d.qemu || [], iol: d.iol || [] };
      state.loaded = true;
      var sub = document.getElementById('pnq-store-sub');
      if (sub) {
        sub.textContent = (d.updated ? 'catalog ' + d.updated.slice(0, 10) : '') +
                          (d.stale ? '  ·  ⚠ offline — showing cached list' : '');
        sub.classList.toggle('pnq-store-stale', !!d.stale);
      }
      renderList();
    }).catch(function () { list.innerHTML = '<div class="pnq-store-err">Failed to reach the image backend.</div>'; });
  }

  function renderList() {
    var list = document.getElementById('pnq-store-list');
    if (!list) return;
    var items = state.data[state.tab] || [];
    var hideInstalled = document.getElementById('pnq-store-missing').checked;
    var q = state.q;
    var shown = items.filter(function (it) {
      if (hideInstalled && it.installed) return false;
      return !q || it.name.toLowerCase().indexOf(q) !== -1;
    });
    document.getElementById('pnq-store-count').textContent =
      shown.length + ' / ' + items.length + ' ' + state.tab.toUpperCase() + ' images';
    if (!shown.length) { list.innerHTML = '<div class="pnq-store-loading">No matching images.</div>'; return; }
    list.innerHTML = '';
    shown.forEach(function (it) {
      var row = el('div', 'pnq-store-row');
      row.dataset.key = state.tab + '-' + it.id;
      row.innerHTML =
        '<div class="pnq-store-info">' +
          '<div class="pnq-store-name" title="' + it.name + '">' + it.name + '</div>' +
          '<div class="pnq-store-meta">' + (it.size || '') + '</div>' +
        '</div>' +
        '<div class="pnq-store-action"></div>';
      renderAction(row, it);
      list.appendChild(row);
    });
  }

  /* (re)render a row's action cell based on installed-state + any live job */
  function renderAction(row, it) {
    var act = row.querySelector('.pnq-store-action');
    act.innerHTML = '';
    var job = state.jobs[row.dataset.key];
    if (job && job.state && job.state !== 'done' && job.state !== 'error' && job.state !== 'removed') {
      renderProgress(act, job); return;
    }
    if (it.installed) {
      var badge = el('span', 'pnq-store-badge pnq-installed', '✓ Installed');
      var del = el('button', 'pnq-store-del');
      del.title = 'Delete image'; del.innerHTML = '<i class="glyphicon glyphicon-trash"></i>';
      del.addEventListener('click', function () {
        if (window.confirm('Delete "' + it.name + '" from disk?')) startJob('delete', it, row);
      });
      act.appendChild(badge); act.appendChild(del);
    } else {
      var b = el('button', 'pnq-store-dl', '<i class="glyphicon glyphicon-download-alt"></i> Download');
      b.addEventListener('click', function () { startJob('download', it, row); });
      act.appendChild(b);
    }
  }

  function renderProgress(act, job) {
    var pct = job.pct || 0;
    var label = job.state === 'downloading' ? pct + '%'
      : job.state === 'installing' ? 'Installing…'
      : job.state === 'finalizing' ? 'Fixing permissions…'
      : job.state === 'deleting' ? 'Removing…'
      : job.state === 'queued' ? 'Queued…' : (job.state || '');
    act.innerHTML =
      '<div class="pnq-store-prog"><div class="pnq-store-prog-bar" style="width:' + pct + '%"></div>' +
      '<span class="pnq-store-prog-txt">' + label + '</span></div>';
  }

  /* one entry point for both download and delete (op = 'download' | 'delete') */
  function startJob(op, it, row) {
    var key = state.tab + '-' + it.id;
    var act = row.querySelector('.pnq-store-action');
    state.jobs[key] = { state: op === 'delete' ? 'deleting' : 'queued', pct: op === 'delete' ? 50 : 0 };
    renderProgress(act, state.jobs[key]);
    api('?action=' + op + '&type=' + state.tab + '&id=' + it.id).then(function (d) {
      if (d.error || !d.job) {
        delete state.jobs[key];
        act.innerHTML = '<span class="pnq-store-badge pnq-err">' + (d.error || 'failed') + '</span>';
        return;
      }
      pollJob(d.job, key, it, row);
    }).catch(function () {
      delete state.jobs[key];
      act.innerHTML = '<span class="pnq-store-badge pnq-err">request failed</span>';
    });
  }

  function pollJob(job, key, it, row) {
    var act = row.querySelector('.pnq-store-action');
    var t = setInterval(function () {
      api('?action=status&job=' + job).then(function (s) {
        if (s.error) return;
        state.jobs[key] = s;
        if (s.state === 'done' || s.state === 'removed') {
          clearInterval(t); delete state.jobs[key];
          it.installed = (s.state === 'done');     // 'removed' → not installed
          state.changed = true;                    // reload on close so Add Node sees it
          renderAction(row, it);
          // If the modal was already closed (user left it downloading in the
          // background), reload now so the finished image is picked up.
          var ov = document.getElementById('pnq-store-overlay');
          if (ov && !ov.classList.contains('pnq-open')) { window.location.reload(); }
        } else if (s.state === 'error') {
          clearInterval(t); delete state.jobs[key];
          act.innerHTML = '<span class="pnq-store-badge pnq-err" title="' + (s.msg || '') + '">✕ ' + (s.msg || 'error') + '</span>';
        } else {
          renderProgress(act, s);
        }
      });
    }, 1500);
  }

  /* ── canvas right-click menu: add an "Image Store" item ─────────────────────
   * The "Add a new object" canvas menu (Node / Network / Custom Shape / Text /
   * Line) is built in actions.js and post-processed by pnetlab-shape.js; we
   * likewise watch for #context-menu landing in the DOM and append an Image
   * Store action to the empty-canvas menu. The item reuses the quickbar's
   * cloud-download icon and opens the same Image Store modal (openStore), so
   * there is no new backend. */
  function injectCanvasMenuItem(menu) {
    if (!menu || menu.dataset.pnqImagestore) return;
    // The add-object canvas menu is the only #context-menu with an "Add Node"
    // (action-nodeplace) anchor — node/shape/connection menus don't have it.
    var addNode = menu.querySelector('a.action-nodeplace');
    if (!addNode) return;                           // node / shape / connection menu — skip
    var ul = menu.querySelector('ul, .dropdown-menu');
    if (!ul) return;
    menu.dataset.pnqImagestore = '1';
    var sep = el('li'); sep.setAttribute('role', 'separator'); sep.className = 'divider';
    var li = el('li');
    li.innerHTML = '<a class="action-imagestore" href="javascript:void(0)">' +
      '<i class="glyphicon glyphicon-cloud-download"></i> Image Store</a>';
    ul.appendChild(sep);
    ul.appendChild(li);
  }

  /* ── main/store-page System menu: "Add Nodes" opens the same Image Store ──── */
  // Same injection pattern as pnq-cluster.js: the header re-renders on
  // navigation, so keep re-asserting the <li> in the System group.
  var MI_ID = 'pnq-imagestore-mi';
  function systemGroupUl() {
    var heads = document.querySelectorAll('li.menu_collapse > .menu_group_button');
    for (var i = 0; i < heads.length; i++) {
      var label = '';
      var kids = heads[i].childNodes;
      for (var k = 0; k < kids.length; k++) if (kids[k].nodeType === 3) label += kids[k].textContent;
      if (/^\s*System\s*$/i.test(label)) {
        return heads[i].parentNode.querySelector('ul.menu_group');
      }
    }
    return null;
  }
  function injectMenuItem() {
    if (document.getElementById(MI_ID)) return;
    var ul = systemGroupUl();
    if (!ul) return;
    var li = el('li', 'menu_item');
    li.id = MI_ID;
    li.innerHTML = '<a href="javascript:void(0)" title="Download QEMU/IOL images from the ishare2 catalog">' +
      '<i class="fa fa-cloud-download"></i>&nbsp;Add Nodes</a>';
    li.querySelector('a').addEventListener('click', function (e) { e.preventDefault(); openStore(); });
    ul.appendChild(li);
  }

  /* ── boot: gate on admin role, then wait for the quickbar ─────────────────── */
  function init() {
    // Only inject for admin users. GET /api/auth returns the session user
    // OBJECT in data (not an array — data[0] never existed; that bug hid the
    // button for everyone, admins included).
    fetch('/api/auth', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var d = j && j.data;
        var role = d ? (d.role != null ? d.role : (d[0] && d[0].role)) : '';
        var isAdmin = (role === 0 || role === '0' || String(role).toLowerCase() === 'admin');
        if (!isAdmin) return;
        injectButton();
        injectMenuItem();
        setInterval(injectMenuItem, 1500);
        var obs = new MutationObserver(function () { injectButton(); injectMenuItem(); });
        obs.observe(document.body, { childList: true, subtree: true });

        // canvas-menu observer (separate so quickbar logic stays untouched)
        var menuMo = new MutationObserver(function (muts) {
          for (var i = 0; i < muts.length; i++) {
            for (var k = 0; k < muts[i].addedNodes.length; k++) {
              var n = muts[i].addedNodes[k];
              if (n.nodeType !== 1) continue;
              var menu = (n.id === 'context-menu') ? n : (n.querySelector && n.querySelector('#context-menu'));
              if (menu) injectCanvasMenuItem(menu);
            }
          }
        });
        menuMo.observe(document.body, { childList: true, subtree: true });

        // open the store from the node menu (capture phase so the menu's own
        // handlers don't fire first); remove the menu before opening.
        document.addEventListener('click', function (e) {
          var t = e.target.closest && e.target.closest('.action-imagestore');
          if (!t) return;
          e.preventDefault(); e.stopImmediatePropagation();
          var cm = document.getElementById('context-menu'); if (cm) cm.remove();
          openStore();
        }, true);
      }).catch(function () {});  // silently skip if /api/auth is unreachable
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
