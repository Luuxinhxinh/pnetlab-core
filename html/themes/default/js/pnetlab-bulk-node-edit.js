/**
 * pnetlab-bulk-node-edit.js — "Bulk Edit Selected" for a multi-node selection.
 *
 * Edit CPU / RAM / Icon / Console type across every selected node at once. The
 * node context menu is built by the minified lab.js, so — like
 * pnetlab-node-duplicate.js / pnetlab-node-rename.js — we watch #context-menu
 * into the DOM and inject a "Bulk Edit Selected" item into the MULTI-SELECT
 * group menu (the same menu Duplicate adds "Duplicate Selected" to). The item
 * only appears for a real multi-selection (≥2 nodes).
 *
 * No bulk API exists. Each field is applied per node through the engine's
 * existing partial-edit path (POST /api/labs/session/nodes/edit, the same call
 * updateNodeData() in functions.js makes): merge window.nodes[id] with the
 * partial and POST it. We POST the nodes SEQUENTIALLY (so an edit never races
 * the next), then refresh the topology ONCE and show one summary — instead of
 * calling updateNodeData() N times (which would printTopology + toast N times).
 *
 * HETEROGENEOUS SELECTIONS: a selection can mix node types (qemu router + IOL
 * switch + VPCS + docker). Not every field is meaningful for every type, so each
 * field is applied ONLY to nodes that actually carry it:
 *   • Icon    — every node has an icon            → applies to all
 *   • CPU/RAM — only nodes with a cpu/ram field   → effectively qemu
 *   • Console — only switchable-lane nodes        → qemu / docker
 * Inapplicable nodes are skipped silently and reported in the summary
 * ("CPU set on 3 — 2 n/a"). The panel shows a live "applies to X of N" hint per
 * field and a per-type breakdown of the selection.
 *
 * CPU/RAM caveat (per functions.js updateNodeData): CPU/RAM/image changes only
 * take real effect after the node's disk is wiped. Per the chosen policy we
 * apply them to ALL selected nodes regardless of power state and surface a
 * notice that running nodes need a stop + wipe; icon/console apply live.
 *
 * Self-contained injected module (loaded by themes/default/index.html), same
 * pattern as pnetlab-node-duplicate.js. Hosted in the shared right-docked glass
 * panel (window.pnqPropsPanel). White Apple-glass palette, accent #3c708a.
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
  function msg(kind, text) {
    if (typeof window.addMessage === 'function') window.addMessage(kind, text);
  }

  /* ── selection (mirrors pnetlab-node-duplicate.js) ───────────────────────────
     window.nodes is keyed by the BARE id (e.g. "13"); lab.js puts that on the
     frame as nid / data-path (the frame's DOM id is the PREFIXED "node13"). Prefer
     nid/data-path; strip the prefix as a last resort. Free-Select mode keeps its
     own list in window.freeSelectedNodes = [{name, path}]. */
  function selectedNodeIds() {
    var out = [];
    document.querySelectorAll('.node_frame.ui-selected').forEach(function (n) {
      var id = n.getAttribute('nid') || n.getAttribute('data-path') || (n.id || '').replace(/^node/, '');
      if (id && out.indexOf(id) === -1) out.push(id);
    });
    if (!out.length && Array.isArray(window.freeSelectedNodes)) {
      window.freeSelectedNodes.forEach(function (n) {
        if (n && n.path != null && out.indexOf(String(n.path)) === -1) out.push(String(n.path));
      });
    }
    return out;
  }

  /* ── per-field applicability ───────────────────────────────────────────────
     Gate on what each node object actually carries so heterogeneous selections
     are handled cleanly. */
  function hasVal(v) { return v !== undefined && v !== null && v !== ''; }
  function supportsCpu(n)     { return !!n && hasVal(n.cpu); }
  function supportsRam(n)     { return !!n && hasVal(n.ram); }
  function supportsConsole(n) { return !!n && hasVal(n.console) && (n.type === 'qemu' || n.type === 'docker'); }
  function isRunning(n)       { return !!n && (parseInt(n.status, 10) | 0) >= 2; }

  function srcNodes(ids) {
    var out = [];
    ids.forEach(function (id) { var s = window.nodes && window.nodes[id]; if (s) out.push({ id: id, n: s }); });
    return out;
  }

  /* ── one partial edit, mirroring functions.js updateNodeData's POST shape ────
     form_data = { ...(window.nodes[id]||{}), ...partial } (the `get(n,{})` there
     is just "n or {}"). Resolves true/false; never refreshes the topology — the
     caller refreshes once at the end. */
  function editOne(id, partial) {
    return new Promise(function (resolve) {
      var base = (window.nodes && window.nodes[id]) || {};
      var form_data = Object.assign({}, base, partial);
      window.$.ajax({
        cache: false, type: 'post', url: encodeURI('/api/labs/session/nodes/edit'),
        dataType: 'json', data: form_data,
        success: function (data) {
          if (data && data.status === 'success') {
            if (data.update && window.App && App.topology && App.topology.updateData) {
              try { App.topology.updateData(data.update); } catch (e) {}
            }
            resolve(true);
          } else { resolve(false); }
        },
        error: function () { resolve(false); }
      });
    });
  }

  /* ── apply the chosen fields across the selection ──────────────────────────── */
  function applyBulk(items, fields, close) {
    // fields: { icon?:str, cpu?:str, ram?:str, console?:str } — only enabled keys present.
    var keys = Object.keys(fields);
    if (!keys.length) { msg('warning', 'Nothing to change — tick a field first.'); return; }

    // Build a per-node partial of only the fields that apply to that node.
    var jobs = [], applied = { icon: 0, cpu: 0, ram: 0, console: 0 },
        skipped = { icon: 0, cpu: 0, ram: 0, console: 0 };
    items.forEach(function (it) {
      var np = {}, n = it.n;
      if ('icon' in fields)    { np.icon = fields.icon; applied.icon++; }
      if ('cpu' in fields)     { supportsCpu(n)     ? (np.cpu = fields.cpu, applied.cpu++)         : skipped.cpu++; }
      if ('ram' in fields)     { supportsRam(n)     ? (np.ram = fields.ram, applied.ram++)         : skipped.ram++; }
      if ('console' in fields) { supportsConsole(n) ? (np.console = fields.console, applied.console++) : skipped.console++; }
      if (Object.keys(np).length) jobs.push({ id: it.id, np: np });
    });

    if (!jobs.length) { msg('warning', 'None of the selected nodes accept the chosen field(s).'); return; }

    if (window.App && App.loading) App.loading(true);
    var ok = 0, fail = 0, chain = Promise.resolve();
    jobs.forEach(function (j) {
      chain = chain.then(function () { return editOne(j.id, j.np).then(function (good) { good ? ok++ : fail++; }); });
    });
    chain.then(function () {
      if (window.App && App.loading) App.loading(false);
      if (window.App && App.topology && App.topology.printTopology) App.topology.printTopology();

      // one concise summary
      var parts = [];
      ['icon', 'cpu', 'ram', 'console'].forEach(function (k) {
        if (!(k in fields)) return;
        var label = (k === 'console') ? 'Console' : k.toUpperCase();
        var s = label + ' set on ' + applied[k];
        if (skipped[k]) s += ' — ' + skipped[k] + ' n/a';
        parts.push(s);
      });
      var summary = parts.join('; ') + (fail ? (' (' + fail + ' failed)') : '');
      msg(fail ? 'warning' : 'success', summary);

      // CPU/RAM running-node reminder
      if (('cpu' in fields) || ('ram' in fields)) {
        var running = items.filter(function (it) {
          return isRunning(it.n) && (supportsCpu(it.n) || supportsRam(it.n));
        }).length;
        if (running) {
          msg('warning', running + ' running node' + (running === 1 ? '' : 's') +
            ' — CPU/RAM take effect after a stop + wipe.');
        }
      }
      if (typeof close === 'function') close();
    });
  }

  /* ── panel UI (hosted in the shared right-docked glass panel) ──────────────── */
  function injectCSS() {
    if (document.getElementById('pnq-bulk-style')) return;
    var s = document.createElement('style');
    s.id = 'pnq-bulk-style';
    s.textContent =
      '.pnq-bulk{display:flex;flex-direction:column;gap:13px;}' +
      '.pnq-bulk-summary{font-size:13px;font-weight:600;color:#1d1d1f;letter-spacing:-.01em;}' +
      '.pnq-bulk-chips{display:flex;flex-wrap:wrap;gap:5px;}' +
      '.pnq-bulk-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(60,112,138,.12);' +
        'color:#2b5066;white-space:nowrap;}' +
      '.pnq-bulk-fields{display:flex;flex-direction:column;gap:12px;}' +
      '.pnq-bulk-row{display:flex;flex-direction:column;gap:5px;}' +
      '.pnq-bulk-en{display:flex;align-items:center;gap:7px;margin:0;font-size:12.5px;font-weight:600;' +
        'color:#1d1d1f;cursor:pointer;}' +
      '.pnq-bulk-en input[type="checkbox"]{margin:0;cursor:pointer;}' +
      '.pnq-bulk-ctl{display:flex;align-items:center;gap:7px;}' +
      '.pnq-bulk-ctl input[type="number"],.pnq-bulk-ctl select{flex:1 1 auto;width:auto;box-sizing:border-box;' +
        'padding:6px 8px;border:1px solid rgba(0,0,0,.16);border-radius:8px;background:#fff;color:#1d1d1f;' +
        'font-size:13px;font-family:inherit;outline:none;}' +
      '.pnq-bulk-ctl input[type="number"]:focus,.pnq-bulk-ctl select:focus{border-color:' + ACCENT + ';}' +
      '.pnq-bulk-unit{font-size:11px;color:#6b6b70;}' +
      '.pnq-bulk-iconbtn{flex:1 1 auto;display:flex;align-items:center;gap:7px;padding:6px 8px;' +
        'border:1px solid rgba(0,0,0,.16);border-radius:8px;background:#fff;color:#1d1d1f;cursor:pointer;' +
        'font-size:12.5px;font-family:inherit;text-align:left;overflow:hidden;}' +
      '.pnq-bulk-iconbtn:hover{border-color:' + ACCENT + ';}' +
      '.pnq-bulk-iconbtn img{width:20px;height:20px;object-fit:contain;flex:0 0 auto;}' +
      '.pnq-bulk-iconbtn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.pnq-bulk-hint{font-size:11px;color:#8a8a8f;}' +
      '.pnq-bulk-note{font-size:11px;line-height:1.45;color:#9a6a16;background:rgba(214,158,46,.12);' +
        'border:1px solid rgba(214,158,46,.28);border-radius:8px;padding:7px 9px;}' +
      '.pnq-bulk-actions{display:flex;gap:8px;margin-top:2px;}' +
      '.pnq-bulk-btn{flex:1 1 0;padding:7px 0;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit;' +
        'border:1px solid rgba(0,0,0,.13);background:rgba(0,0,0,.05);color:#1d1d1f;}' +
      '.pnq-bulk-apply{background:' + ACCENT + ';color:#fff;border-color:' + ACCENT + ';font-weight:500;}' +
      '.pnq-bulk-row.pnq-off .pnq-bulk-ctl{opacity:.45;}' +
      'body.pnq-dark .pnq-bulk-summary,body.pnq-dark .pnq-bulk-en{color:#f2f2f3;}' +
      'body.pnq-dark .pnq-bulk-chip{background:rgba(120,170,200,.18);color:#bcd6e6;}' +
      'body.pnq-dark .pnq-bulk-ctl input,body.pnq-dark .pnq-bulk-ctl select,body.pnq-dark .pnq-bulk-iconbtn{' +
        'background:rgba(255,255,255,.06);color:#f2f2f3;border-color:rgba(255,255,255,.16);}' +
      'body.pnq-dark .pnq-bulk-hint{color:#9a9aa0;}';
    (document.head || document.documentElement).appendChild(s);
  }

  // type breakdown chips: "3 qemu · 1 iol · 2 vpcs"
  function typeChips(items) {
    var counts = {};
    items.forEach(function (it) { var t = (it.n.type || '?'); counts[t] = (counts[t] || 0) + 1; });
    return Object.keys(counts).sort().map(function (t) {
      return '<span class="pnq-bulk-chip">' + counts[t] + ' ' + t + '</span>';
    }).join('');
  }

  function openPanel(ids) {
    var items = srcNodes(ids);
    if (items.length < 2) { msg('warning', 'Select two or more nodes first.'); return; }
    if (!window.pnqPropsPanel || !window.$) {
      msg('danger', 'Bulk edit unavailable (panel/jQuery missing).'); return;
    }
    injectCSS();

    var nCpu = items.filter(function (it) { return supportsCpu(it.n); }).length;
    var nRam = items.filter(function (it) { return supportsRam(it.n); }).length;
    var nCon = items.filter(function (it) { return supportsConsole(it.n); }).length;
    var N = items.length;

    var handle = window.pnqPropsPanel.open({ title: 'Bulk Edit — ' + N + ' nodes' });
    var body = handle.body;

    var wrap = el('div', 'pnq-bulk');
    wrap.innerHTML =
      '<div class="pnq-bulk-summary">' + N + ' nodes selected</div>' +
      '<div class="pnq-bulk-chips">' + typeChips(items) + '</div>' +
      '<div class="pnq-bulk-fields">' +
        // Icon
        '<div class="pnq-bulk-row pnq-off" data-f="icon">' +
          '<label class="pnq-bulk-en"><input type="checkbox" data-en="icon"> Icon</label>' +
          '<div class="pnq-bulk-ctl"><button type="button" class="pnq-bulk-iconbtn" data-icon-btn>' +
            '<img data-icon-img alt=""><span data-icon-name>Choose icon…</span></button></div>' +
          '<div class="pnq-bulk-hint">applies to all ' + N + '</div>' +
        '</div>' +
        // CPU
        '<div class="pnq-bulk-row pnq-off" data-f="cpu">' +
          '<label class="pnq-bulk-en"><input type="checkbox" data-en="cpu"> CPU (vCPUs)</label>' +
          '<div class="pnq-bulk-ctl"><input type="number" min="1" step="1" data-v="cpu" placeholder="e.g. 2"></div>' +
          '<div class="pnq-bulk-hint">applies to ' + nCpu + ' of ' + N + (nCpu < N ? ' (others n/a)' : '') + '</div>' +
        '</div>' +
        // RAM
        '<div class="pnq-bulk-row pnq-off" data-f="ram">' +
          '<label class="pnq-bulk-en"><input type="checkbox" data-en="ram"> RAM</label>' +
          '<div class="pnq-bulk-ctl"><input type="number" min="1" step="1" data-v="ram" placeholder="e.g. 1024">' +
            '<span class="pnq-bulk-unit">MB</span></div>' +
          '<div class="pnq-bulk-hint">applies to ' + nRam + ' of ' + N + (nRam < N ? ' (others n/a)' : '') + '</div>' +
        '</div>' +
        // Console
        '<div class="pnq-bulk-row pnq-off" data-f="console">' +
          '<label class="pnq-bulk-en"><input type="checkbox" data-en="console"> Console type</label>' +
          '<div class="pnq-bulk-ctl"><select data-v="console">' +
            '<option value="telnet">Telnet</option><option value="vnc">VNC</option>' +
            '<option value="rdp">RDP</option></select></div>' +
          '<div class="pnq-bulk-hint">applies to ' + nCon + ' of ' + N +
            (nCon < N ? ' (telnet-only / fixed nodes n/a)' : '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="pnq-bulk-note">CPU/RAM changes take effect after the node is stopped and its ' +
        'disk wiped. Icon &amp; console apply immediately.</div>' +
      '<div class="pnq-bulk-actions">' +
        '<button type="button" class="pnq-bulk-btn pnq-bulk-cancel">Cancel</button>' +
        '<button type="button" class="pnq-bulk-btn pnq-bulk-apply">Apply</button>' +
      '</div>';
    body.appendChild(wrap);

    // enable/disable visual + checkbox helpers
    function rowOf(name) { return wrap.querySelector('.pnq-bulk-row[data-f="' + name + '"]'); }
    function enBox(name) { return wrap.querySelector('input[data-en="' + name + '"]'); }
    function setEnabled(name, on) {
      var b = enBox(name); if (b) b.checked = on;
      var r = rowOf(name); if (r) r.classList.toggle('pnq-off', !on);
    }
    ['icon', 'cpu', 'ram', 'console'].forEach(function (name) {
      var b = enBox(name);
      if (b) b.addEventListener('change', function () { rowOf(name).classList.toggle('pnq-off', !b.checked); });
    });
    // touching a control auto-ticks its enable box
    wrap.querySelectorAll('input[data-v], select[data-v]').forEach(function (ctl) {
      var name = ctl.getAttribute('data-v');
      ctl.addEventListener('input', function () { setEnabled(name, true); });
      ctl.addEventListener('change', function () { setEnabled(name, true); });
    });

    // icon picker — reuse the white-glass dropdown node-form.js installed over selectImage(cb)
    var iconVal = '';
    var iconImg = wrap.querySelector('[data-icon-img]');
    var iconName = wrap.querySelector('[data-icon-name]');
    iconImg.style.display = 'none';
    wrap.querySelector('[data-icon-btn]').addEventListener('click', function () {
      if (typeof window.selectImage !== 'function') { msg('danger', 'Icon picker unavailable.'); return; }
      window.selectImage(function (name) {
        if (!name) return;
        iconVal = name;
        iconImg.src = '/images/icons/' + encodeURIComponent(name);
        iconImg.style.display = '';
        iconName.textContent = name;
        setEnabled('icon', true);
      });
    });

    // actions
    wrap.querySelector('.pnq-bulk-cancel').addEventListener('click', function () { window.pnqPropsPanel.close(); });
    wrap.querySelector('.pnq-bulk-apply').addEventListener('click', function () {
      var fields = {};
      if (enBox('icon').checked) {
        if (!iconVal) { msg('warning', 'Pick an icon or untick Icon.'); return; }
        fields.icon = iconVal;
      }
      if (enBox('cpu').checked) {
        var c = parseInt(wrap.querySelector('[data-v="cpu"]').value, 10);
        if (!(c >= 1)) { msg('warning', 'Enter a valid CPU count (≥1).'); return; }
        fields.cpu = String(c);
      }
      if (enBox('ram').checked) {
        var r = parseInt(wrap.querySelector('[data-v="ram"]').value, 10);
        if (!(r >= 1)) { msg('warning', 'Enter a valid RAM size in MB (≥1).'); return; }
        fields.ram = String(r);
      }
      if (enBox('console').checked) {
        fields.console = wrap.querySelector('[data-v="console"]').value;
      }
      applyBulk(items, fields, function () { window.pnqPropsPanel.close(); });
    });
  }

  /* ── inject "Bulk Edit Selected" into the multi-select group menu ──────────── */
  function injectMenu(menu) {
    if (!menu || menu.dataset.pnqBulk) return;
    // single-node menu has action-nodeedit; group menu does not (it has *-group actions)
    if (menu.querySelector('a.action-nodeedit[data-path]')) return;     // skip single-node menu
    var groupAnchor = menu.querySelector('a[class*="-group"]');
    if (!groupAnchor) return;                                           // not a group menu
    if (selectedNodeIds().length < 2) return;                          // only for a real multi-selection
    menu.dataset.pnqBulk = '1';

    var li = el('li');
    li.innerHTML = '<a class="action-bulkedit" href="javascript:void(0)">' +
      '<i class="glyphicon glyphicon-edit"></i> Bulk Edit Selected</a>';
    // place under "Duplicate Selected" if present, else at the top
    var dup = menu.querySelector('a.action-duplicate-all');
    var dupLi = dup && dup.closest('li');
    if (dupLi && dupLi.parentNode) dupLi.parentNode.insertBefore(li, dupLi.nextSibling);
    else {
      var firstLi = groupAnchor.closest('li');
      if (firstLi && firstLi.parentNode) firstLi.parentNode.insertBefore(li, firstLi);
      else menu.querySelector('ul, .dropdown-menu').appendChild(li);
    }

    // menu grew after printContextMenu() measured it — pull up if it now overflows
    var screenH = (document.getElementById('body') || document.documentElement).offsetHeight || window.innerHeight;
    var overflow = menu.getBoundingClientRect().bottom - screenH;
    if (overflow > 0) {
      var curTop = parseInt(menu.style.top, 10) || 0;
      menu.style.top = Math.max(0, curTop - overflow) + 'px';
    }
  }

  // capture-phase click so the menu's own handlers don't fire first
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('.action-bulkedit');
    if (!t) return;
    e.preventDefault(); e.stopImmediatePropagation();
    var ids = selectedNodeIds();
    var cm = document.getElementById('context-menu'); if (cm) cm.remove();
    openPanel(ids);
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
