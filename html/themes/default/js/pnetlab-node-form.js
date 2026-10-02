/**
 * pnetlab-node-form.js — EVE-NG Pro layout for the Add Node / Edit Node modals.
 *
 * Restructures #form-node-data into the EVE-NG Pro 6.5 two-column split:
 *   33% "Main Settings" (left)  |  67% "Additional Settings" (right)
 * adapted to PNetLab's dark-green glass theme.
 *
 * Design goal: the whole modal fits in one pane WITHOUT scrolling, exactly
 * like EVE-NG. PNetLab templates expose many more fields than EVE, so the
 * left column is a small whitelist (the EVE "Main Settings" set) and every
 * other field flows into a compact 2-column grid on the right.
 */
(function () {
  'use strict';

  /* ── DOM helpers ──────────────────────────────────────────────────────── */
  function mk(tag, cls) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }
  function mkTitle(text, cls) {
    var el = mk('div', cls || 'pnq-group-title');
    el.textContent = text;
    return el;
  }
  function mkFieldTitle(text) {
    var el = mk('div', 'pnq-field-title');
    el.textContent = text;
    return el;
  }
  function labelOf(groupEl) {
    var lbl = groupEl.querySelector('label');
    return lbl ? lbl.textContent.trim() : '';
  }
  function norm(lbl) {
    return lbl.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  }

  /* ── Field classification ─────────────────────────────────────────────────
     Buckets:
       NAME / COUNT          → paired top row of Main
       MAIN                  → image, icon, startup config (left column)
       SATELLITE / DELAY     → paired row of Main
       POS                   → left/top paired row of Main
       QEMU                  → QEMU sub-group (right)
       RES                   → cpu / ram / cpulimit / ethernet / nvram (right row)
       CONSOLE               → console / 2nd console / terminal / backspace (right grid)
       IFACE                 → eth_format / eth_name (right sub-group)
       MISC                  → everything else (right 2-col grid)
  ──────────────────────────────────────────────────────────────────────────*/
  function classify(lbl) {
    var l = norm(lbl);

    /* ---- Main column (left) ---- */
    if (/^name\b/.test(l))                                  return 'NAME';
    if (/^number of nodes|^id$/.test(l))                    return 'COUNT';
    if (/^image\b/.test(l))                                 return 'MAIN';
    if (/^icon\b/.test(l))                                  return 'MAIN';
    if (/^config$|^configuration$|^startup config/.test(l)) return 'MAIN';
    if (/initial start|start-?up config/.test(l))           return 'MAIN';
    /* CPU / RAM / Console settings moved into Main (swapped with Delay/Left/Top) */
    if (/^cpu limit/.test(l))                               return 'RES';   /* CPU Limit stays right */
    if (/^cpu\b/.test(l))                                   return 'CPU';   /* CPU      → left  */
    if (/^ram\b|^memory\b/.test(l))                         return 'RAM';   /* RAM      → left  */
    if (/console|terminal type|backspace|html5 terminal/.test(l)) return 'CONSOLE'; /* console → left */

    /* ---- Additional column (right) ---- */
    if (/^qemu/.test(l))                                    return 'QEMU';
    if (/^nvram\b/.test(l))                                 return 'RES';
    if (/^ethernet\b|^ethernets\b/.test(l))                 return 'RES';
    if (/^eth format|^eth name|interface format|interface name|custom interface/.test(l)) return 'IFACE';

    /* ---- Everything else (incl. Delay, Left, Top, Satellite) → right grid ---- */
    return 'MISC';
  }

  /* ── Generic builders ─────────────────────────────────────────────────── */
  function appendFull(container, item) {
    item.el.className = 'pnq-field-container';
    container.appendChild(item.el);
  }
  function appendRow(container, items) {
    if (!items.length) return;
    var row = mk('div', 'pnq-fields-row');
    items.forEach(function (it) {
      it.el.className = 'pnq-field-container';
      row.appendChild(it.el);
    });
    container.appendChild(row);
  }
  function appendGrid(container, items) {
    if (!items.length) return;
    var grid = mk('div', 'pnq-misc-grid');
    items.forEach(function (it) {
      it.el.className = 'pnq-field-container';
      grid.appendChild(it.el);
    });
    container.appendChild(grid);
  }
  /* Fixed 2-column grid (for the narrow left column) */
  function appendGrid2(container, items) {
    if (!items.length) return;
    var grid = mk('div', 'pnq-grid2col');
    items.forEach(function (it) {
      it.el.className = 'pnq-field-container';
      grid.appendChild(it.el);
    });
    container.appendChild(grid);
  }

  /* ── Left column: Main Settings ───────────────────────────────────────── */
  function buildMainColumn(card, b) {
    /* Name + Count row */
    if (b.NAME.length && b.COUNT.length) {
      var row = mk('div', 'pnq-fields-row');
      b.NAME[0].el.className  = 'pnq-field-container pnq-name-field';
      b.COUNT[0].el.className = 'pnq-field-container pnq-count-field';
      renameCountLabel(b.COUNT[0].el);
      row.appendChild(b.NAME[0].el);
      row.appendChild(b.COUNT[0].el);
      card.appendChild(row);
    } else {
      b.NAME.forEach(function (it) { appendFull(card, it); });
      b.COUNT.forEach(function (it) { appendFull(card, it); });
    }

    /* image / icon / startup config (in DOM order they were added) */
    b.MAIN.forEach(function (it) { appendFull(card, it); });

    /* CPU + RAM row (moved here from Additional) */
    if (b.CPU.length || b.RAM.length) {
      appendRow(card, b.CPU.concat(b.RAM));
    }

    /* Console settings — 2-column grid to stay compact in the narrow column */
    appendGrid2(card, b.CONSOLE);
  }

  /* ── Right column: Additional Settings ─────────────────────────────────────
     Only QEMU keeps its own bordered sub-group (it is semantically distinct and
     EVE-NG renders it that way). The resource fields share one wrap-row. Every
     other field — console, interface labels, and template-specific extras —
     flows into a single compact 2-column grid. Folding the console/interface
     fields into that grid (instead of separate bordered sub-groups) removes the
     wasted border+title vertical space and keeps the whole modal scroll-free.
  ──────────────────────────────────────────────────────────────────────────*/
  function buildAdditionalColumn(card, b) {
    /* QEMU sub-group */
    if (b.QEMU.length) {
      var qg = mk('div', 'pnq-qemu-group');
      qg.appendChild(mkFieldTitle('QEMU Settings'));
      var rowFields = [], fullFields = [];
      b.QEMU.forEach(function (it) {
        var l = norm(it.lbl);
        if (/version|arch|nic/.test(l)) rowFields.push(it);
        else fullFields.push(it);
      });
      appendRow(qg, rowFields);
      fullFields.forEach(function (it) { appendFull(qg, it); });
      card.appendChild(qg);
    }

    /* Resources row: CPU Limit / Ethernet / NVRAM (CPU & RAM now in Main) */
    if (b.RES.length) {
      var rrow = mk('div', 'pnq-fields-row pnq-res-row');
      b.RES.forEach(function (it) {
        it.el.className = 'pnq-field-container';
        rrow.appendChild(it.el);
      });
      card.appendChild(rrow);
    }

    /* Interface labels + all template extras (Delay, Left, Top, …) → 2-col grid */
    var grid = b.IFACE.concat(b.MISC);
    appendGrid(card, grid);
  }

  /* ── Main organiser ───────────────────────────────────────────────────── */
  function organize(fd) {
    var rawGroups = Array.prototype.filter.call(fd.children, function (c) {
      return c.className && c.className.indexOf('col-xs-12') !== -1;
    });
    if (!rawGroups.length) return;

    var buckets = {
      NAME: [], COUNT: [], MAIN: [], CPU: [], RAM: [], CONSOLE: [],
      QEMU: [], RES: [], IFACE: [], MISC: []
    };
    rawGroups.forEach(function (el) {
      renameClusterLabel(el);
      var lbl = labelOf(el);
      var cat = classify(lbl);
      buckets[cat].push({ el: el, lbl: lbl });
    });

    var layout = mk('div', 'pnq-form-layout');

    /* Left 33% */
    var leftCol  = mk('div', 'pnq-form-column');
    var leftCard = mk('div', 'pnq-field-group');
    leftCard.appendChild(mkTitle('Main Settings'));
    buildMainColumn(leftCard, buckets);
    leftCol.appendChild(leftCard);
    layout.appendChild(leftCol);

    /* Right 67% */
    var rightCol  = mk('div', 'pnq-form-column-group');
    var rightCard = mk('div', 'pnq-field-group');
    rightCard.appendChild(mkTitle('Additional Settings'));
    buildAdditionalColumn(rightCard, buckets);
    rightCol.appendChild(rightCard);
    layout.appendChild(rightCol);

    while (fd.firstChild) fd.removeChild(fd.firstChild);
    if (isAddMode()) fd.appendChild(buildBackBar());   /* Back-to-templates bar */
    fd.appendChild(layout);
  }

  /* ── Template dropdown: add data-subtext = template_id ────────────────── */
  function addSubtext() {
    var sel = document.getElementById('form-node-template');
    if (!sel || sel.dataset.pnqSub) return;
    var n = 0;
    Array.prototype.forEach.call(sel.options, function (opt) {
      if (opt.value && !opt.dataset.subtext) {
        opt.setAttribute('data-subtext', opt.value);
        n++;
      }
    });
    if (n) {
      sel.dataset.pnqSub = '1';
      try { if (window.$) $(sel).selectpicker('refresh'); } catch (e) { /* */ }
    }
  }

  /* ── Per-template icon map (slug → icon filename) ───────────────────────────
     Generated from the template YAMLs into pnetlab-template-icons.json. Lets the
     EVE-style picker show the real node icon next to each template name.
  ──────────────────────────────────────────────────────────────────────────*/
  var ICON_MAP = null, ICON_PENDING = false;
  /* PNetLab docker server nodes whose icons aren't in the upstream
     pnetlab-template-icons.json — fill them in so the EVE-style picker shows
     the real node icon. Applied only when the slug is absent, so a future
     upstream map entry still wins (and matches each template's icon: field). */
  var CUSTOM_ICONS = {
    tacplus: 'Server-2D-SEC-S.svg',
    radius:  'Server-2D-LDAP-S.svg',
    syslog:  'Misc-2D-LogZilla-S.svg',
    splunk:  'Misc-2D-Network-Analyzer-S.svg',
    /* Wireless emulation nodes (match each template's icon: field). */
    wifiap:     'Access Point Green.png',
    wifista:    'Laptop.png',
    wificlient: 'Desktop_linux.png'
  };
  function setIconMap(j) {
    ICON_MAP = j || {};
    for (var k in CUSTOM_ICONS) { if (!ICON_MAP[k]) ICON_MAP[k] = CUSTOM_ICONS[k]; }
  }
  function loadIconMap(cb) {
    if (ICON_MAP) { if (cb) cb(); return; }
    if (ICON_PENDING) return;
    ICON_PENDING = true;
    try {
      // Live slug->icon map from the template YAMLs (every template's own icon:),
      // so new templates show the right icon without regenerating a static file.
      fetch('/api/list/template-icons', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) { setIconMap(j && j.data ? j.data : {}); if (cb) cb(); })
        .catch(function () { setIconMap({}); });
    } catch (e) { setIconMap({}); }
  }

  /* Prepend the node icon to each row of the inline template list.
     Bootstrap-Select renders one <li> per <option> in order, so li[i] ↔ option[i]. */
  function addRowIcons(sel) {
    if (!ICON_MAP) { loadIconMap(function () { addRowIcons(sel); }); return; }
    var bs = sel.parentElement && sel.parentElement.querySelector('.bootstrap-select');
    if (!bs) return;
    var lis = bs.querySelectorAll('.dropdown-menu.inner > li');
    var opts = sel.options;
    for (var i = 0; i < lis.length && i < opts.length; i++) {
      var a = lis[i].querySelector('a');
      if (!a || a.querySelector('.pnq-tpl-icon')) continue;
      var slug = opts[i].value;
      if (!slug) continue;                       /* skip "Nothing selected" */
      var icon = ICON_MAP[slug];
      var img = document.createElement('img');
      img.className = 'pnq-tpl-icon';
      img.alt = '';
      img.src = icon ? ('/images/icons/' + encodeURIComponent(icon))
                     : '/images/icons/Router.png';
      a.insertBefore(img, a.firstChild);
    }
  }

  /* ── "Back to templates" bar (form mode, Add only) ──────────────────────────
     In-place template switching from the settings form blanks out, because the
     React re-render reconciles against the DOM that organize() restructured.
     Instead we hide the in-form dropdown and offer a Back button that re-invokes
     the Add Node action — which resets the (reused) modal to a fresh picker.
  ──────────────────────────────────────────────────────────────────────────*/
  function buildBackBar() {
    var sel = document.getElementById('form-node-template');
    var name = '';
    if (sel && sel.options[sel.selectedIndex]) name = sel.options[sel.selectedIndex].textContent.trim();
    var bar = mk('div', 'pnq-backbar');
    var btn = mk('button', 'pnq-back-btn');
    btn.type = 'button';
    btn.innerHTML = '<i class="fa fa-chevron-left"></i>&nbsp;Back to templates';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var act = document.querySelector('.action-nodeplace');
      if (act) act.click();                      /* fresh pick-mode modal */
    });
    var nm = mk('span', 'pnq-back-name');
    nm.textContent = name;
    bar.appendChild(btn);
    bar.appendChild(nm);
    return bar;
  }

  /* Give the node-count field a clear, short heading that fits its column.
     PNetLab's label "Number of nodes to add" truncates in the narrow count
     field; rename to EVE's "Number of Nodes". Add mode only — in edit mode the
     paired field is "ID", which we leave alone. */
  /* "cluster_host" ships from the engine as a bare param key — show the
     friendlier "Run on" (Master / Satellite N) instead. */
  function renameClusterLabel(el) {
    var lbl = el.querySelector('label');
    if (!lbl) return;
    if (!/^cluster[_\s]*host/i.test(lbl.textContent.trim())) return;
    for (var n = lbl.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && /cluster/i.test(n.nodeValue)) { n.nodeValue = 'Run on'; return; }
    }
    lbl.textContent = 'Run on';
  }

  function renameCountLabel(el) {
    var lbl = el.querySelector('label');
    if (!lbl) return;
    var txt = lbl.textContent.trim();
    if (!/number of nodes/i.test(txt)) return;     /* skip "ID" (edit mode) */
    lbl.title = txt;
    var hasEl = false;
    for (var n = lbl.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) { hasEl = true; break; }
    }
    if (!hasEl) { lbl.textContent = 'Number of Nodes'; return; }
    for (var m = lbl.firstChild; m; m = m.nextSibling) {
      if (m.nodeType === 3 && /node/i.test(m.nodeValue)) m.nodeValue = 'Number of Nodes';
    }
  }

  function isAddMode() {
    var sa = document.querySelector('#form-node-showall input');
    return sa ? !sa.disabled : true;             /* showall is disabled in edit mode */
  }

  /* ── Auto-increment the node name by how many of that type already exist ──────
     The React Add Node form prefills the name with the template default (e.g.
     "vIOS"); adding several leaves duplicates. On form open we look up the running
     lab's node names and set the name to the next free "<base>-<n>" (base, base-1,
     base-2, …) — tracking what's already deployed. Manual edits are respected
     (typing doesn't fire the form observer, so we never clobber mid-type, and a
     real edit sets a flag); switching template recomputes from the new base. */
  var nfTpl = null, nfProg = false, nfNames = null, nfNamesTs = 0;
  function fetchNodeNames() {
    if (nfNames && Date.now() - nfNamesTs < 600) return Promise.resolve(nfNames);
    return fetch('/api/labs/session/nodes', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var d = (j && j.data) || {}, s = {};
        Object.keys(d).forEach(function (k) { var n = d[k] || {}; if (n.name != null) s[String(n.name)] = 1; });
        nfNames = s; nfNamesTs = Date.now(); return s;
      })
      .catch(function () { return nfNames || {}; });
  }
  function nextFreeName(base, names) {
    if (!names[base]) return base;
    var i = 1; while (names[base + '-' + i]) i++; return base + '-' + i;
  }
  function setReactInputValue(input, value) {
    try {
      var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (d && d.set) d.set.call(input, value); else input.value = value;
    } catch (e) { input.value = value; }
    input.dispatchEvent(new Event('input', { bubbles: true }));   // let React sync its state
  }
  function findNameInput(fd) {
    var conts = fd.querySelectorAll('.pnq-field-container, .col-xs-12');
    for (var i = 0; i < conts.length; i++) {
      var lbl = conts[i].querySelector('label');
      if (lbl && /^\s*name\b/i.test(lbl.textContent || '')) {
        var inp = conts[i].querySelector('input[type="text"], input:not([type])');
        if (inp) return inp;
      }
    }
    return null;
  }
  function prefillNodeName(fd) {
    if (!isAddMode()) return;
    var input = findNameInput(fd); if (!input) return;
    var sel = document.getElementById('form-node-template');
    var tpl = sel ? sel.value : '';
    if (tpl !== nfTpl) { nfTpl = tpl; input.dataset.pnqUserTyped = ''; }   // new template -> fresh node
    if (!input.dataset.pnqNameHook) {
      input.dataset.pnqNameHook = '1';
      input.addEventListener('input', function () { if (!nfProg) input.dataset.pnqUserTyped = '1'; });
    }
    if (input.dataset.pnqUserTyped === '1') return;            // respect a manual edit
    var raw = (input.value || '').trim();
    if (!raw && sel && sel.options[sel.selectedIndex]) raw = sel.options[sel.selectedIndex].textContent.trim();
    if (!raw) return;
    var base = raw.replace(/-\d+$/, '');                       // strip our own suffix to get the base
    fetchNodeNames().then(function (names) {
      if (input.dataset.pnqUserTyped === '1') return;
      var nn = nextFreeName(base, names);
      if (nn === (input.value || '').trim()) return;           // already correct -> no churn
      nfProg = true; setReactInputValue(input, nn); nfProg = false;
    });
  }

  /* ── White Apple-glass for sibling modals ──────────────────────────────────
     Tag Add Network / Add Picture / Startup Configs / System Status modals with
     `.pnq-white-modal` so they share the Add Node modal's white-glass + system
     typography (CSS scoped to that class in pnetlab-enhance-v2.css). Each is
     identified by a stable inner marker (System Status by its header text). */
  function tagWhiteModals() {
    ['#form-network-add', '#form-picture-add', '.row-config-list', '#addConn'].forEach(function (sel) {
      var nodes = document.querySelectorAll(sel);
      Array.prototype.forEach.call(nodes, function (el) {
        var mc = el.closest('.modal-content');
        if (mc) mc.classList.add('pnq-white-modal');
      });
    });
    var mcs = document.querySelectorAll('.modal .modal-content');
    Array.prototype.forEach.call(mcs, function (mc) {
      if (mc.classList.contains('pnq-white-modal')) return;
      var h = mc.querySelector('.modal-header');
      if (h && /system status/i.test(h.textContent || '')) mc.classList.add('pnq-white-modal');
    });
    pnqStyleNetworkForm();
    pnqStyleLinkForm();
  }

  /* Add Network modal: restyle to EVE-NG's layout — wrap the fields in a bordered
     "field-group" card (#3c708a) with stacked labels, move Icon to the 2nd row,
     and put Left/Top in a 50/50 row. The icon picker works via the global
     selectImage override. Idempotent (guarded by a dataset flag). */
  function pnqStyleNetworkForm() {
    var form = document.querySelector('#form-network-add, #form-network-edit');
    if (!form || form.dataset.pnqNetStyled) return;
    var fieldGroups = Array.prototype.filter.call(form.children, function (c) {
      return c.classList && c.classList.contains('form-group');
    });
    if (fieldGroups.length < 2) return;            /* not built yet */
    form.classList.add('pnq-net-form');

    /* 1. Icon → 2nd row (right after count/ID) */
    var npv = form.querySelector('#networkimage_preview');
    var iconGroup = npv && npv.closest('.form-group');
    if (iconGroup && fieldGroups[0] && iconGroup !== fieldGroups[0]) {
      fieldGroups[0].insertAdjacentElement('afterend', iconGroup);
    }

    /* 2. Left + Top → one 50/50 row */
    var lg = form.querySelector('input[name="network[left]"]'); lg = lg && lg.closest('.form-group');
    var tg = form.querySelector('input[name="network[top]"]');  tg = tg && tg.closest('.form-group');
    if (lg && tg) {
      var row = document.createElement('div'); row.className = 'pnq-net-row';
      lg.insertAdjacentElement('beforebegin', row);
      lg.classList.add('pnq-net-half'); tg.classList.add('pnq-net-half');
      row.appendChild(lg); row.appendChild(tg);
    }

    /* 3. wrap all field rows (not the Save/Cancel row) in a titled card */
    var btnRow = null;
    Array.prototype.forEach.call(form.children, function (c) {
      if (c.querySelector && c.querySelector('button[type="submit"], .btn-success')) btnRow = c;
    });
    var card = document.createElement('div'); card.className = 'pnq-net-card';
    var title = document.createElement('div'); title.className = 'pnq-net-card-title';
    title.textContent = 'Network Settings';
    var firstField = form.querySelector('.form-group, .pnq-net-row');
    if (firstField) form.insertBefore(card, firstField); else form.appendChild(card);
    card.appendChild(title);
    Array.prototype.slice.call(form.children).forEach(function (c) {
      if (c === card || c === btnRow) return;
      if (c.classList && (c.classList.contains('form-group') || c.classList.contains('pnq-net-row'))) card.appendChild(c);
    });

    /* 4. Type picker: force it to open DOWNWARD and be scrollable (it ships as a
       Bootstrap-Select that auto-flips up). Flip the live instance options
       (best-effort, version-agnostic try) + tag the wrapper so CSS pins it down. */
    var typeSel = form.querySelector('select[name="network[type]"]');
    if (typeSel && window.jQuery) {
      try {
        var $t = window.jQuery(typeSel);
        var inst = $t.data('selectpicker');
        if (inst && inst.options) { inst.options.dropupAuto = false; inst.options.size = 8; }
        typeSel.setAttribute('data-dropup-auto', 'false');
        typeSel.setAttribute('data-size', '8');
        var bs = typeSel.parentElement && typeSel.parentElement.querySelector('.bootstrap-select');
        if (bs) bs.classList.add('pnq-net-type');
      } catch (e) {}
    }

    form.dataset.pnqNetStyled = '1';
  }

  /* ── Create Link modal (newConnModal → #addConn) — EVE "Create Link" layout ──
     PNetLab builds #addConn (functions.js) as a left vertical preview column +
     a right column of ID/Name/type text blocks and two interface <select>s.
     EVE-NG shows a compact horizontal preview (src icon — line — dst icon, with
     interface chips + node names) above two stacked "Source/Destination node
     (NAME)" interface pickers, then Save/Cancel. We rebuild that layout by
     cherry-picking the LIVE elements (icons, the .addConnSrc/.addConnDst <text>
     nodes that the change-handlers keep updating, and the .srcConn/.dstConn
     selects + buttons) into a new body, then hiding the original .row. The form
     is plain jQuery (addModal) — not React — so reparenting is safe. Idempotent
     via a dataset flag. White-glass palette comes from .pnq-white-modal (already
     tagged) + the .pnq-link-* block in pnetlab-enhance-v2.css. */
  function pnqLinkSelVisible(sel) {
    var w = sel && sel.closest('.form-group');
    return !!sel && !(w && w.classList.contains('hidden'));
  }
  function pnqLinkField(label, sel) {
    var f = document.createElement('div'); f.className = 'pnq-link-field';
    var h = document.createElement('strong'); h.className = 'pnq-link-field-title';
    h.textContent = label;
    f.appendChild(h); f.appendChild(sel);
    return f;
  }
  /* EVE shows "Choose Interface for Source/Destination" as the picker caption.
     Reproduce it as a native <optgroup> header inside the dropdown so it appears
     above the interface options. Idempotent; preserves the live options (the
     .srcConn/.dstConn change-handlers still resolve them inside the optgroup). */
  function pnqLinkOptgroup(sel, label) {
    if (!sel || sel.querySelector('optgroup')) return;
    var og = document.createElement('optgroup'); og.label = label;
    while (sel.firstChild) og.appendChild(sel.firstChild);
    sel.appendChild(og);
    /* Default to the FIRST free interface (backlog #8). functions.js builds the
       options in ascending natSort order with connected interfaces disabled and no
       explicit `selected`, so the browser would normally select the first enabled
       one. But the optgroup reparent above drops that implicit selection, letting
       it fall back to the LAST option (e.g. e3/3 instead of e0/0). Re-assert the
       first non-disabled option and sync the preview label via the change handler. */
    for (var i = 0; i < sel.options.length; i++) {
      if (!sel.options[i].disabled) {
        if (sel.selectedIndex !== i) {
          sel.selectedIndex = i;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        break;
      }
    }
  }
  function pnqStyleLinkForm() {
    var form = document.getElementById('addConn');
    if (!form || form.dataset.pnqLinkStyled) return;
    var row = form.querySelector('.row');
    var saveBtn = form.querySelector('.addConn-form-save');
    if (!row || !saveBtn) return;                 /* not built yet */

    var col4 = row.querySelector('.col-md-4');
    var imgs = col4 ? col4.querySelectorAll('img') : [];
    var srcImg = imgs[0], dstImg = imgs[1];
    var srcIface = form.querySelector('.addConnSrc');
    var dstIface = form.querySelector('.addConnDst');
    var srcSel = form.querySelector('select.srcConn');
    var dstSel = form.querySelector('select.dstConn');
    var cancelBtn = form.querySelector('.cancelForm');
    var srcName = (srcImg && srcImg.previousElementSibling) ? srcImg.previousElementSibling.textContent.trim() : '';
    var dstName = (dstImg && dstImg.nextElementSibling) ? dstImg.nextElementSibling.textContent.trim() : '';

    form.classList.add('pnq-link-form');

    var body = document.createElement('div'); body.className = 'pnq-link-body';

    /* horizontal preview: [src icon+iface] — line — [dst icon+iface], names below */
    var pv = document.createElement('div'); pv.className = 'pnq-link-preview';
    var gL = document.createElement('div'); gL.className = 'pnq-link-node';
    var iconL = document.createElement('div'); iconL.className = 'pnq-link-icon';
    if (srcImg) { srcImg.className = 'pnq-link-img'; srcImg.removeAttribute('style'); iconL.appendChild(srcImg); }
    if (srcIface) { srcIface.classList.add('pnq-link-iface', 'pnq-link-iface-left'); iconL.appendChild(srcIface); }
    var nameL = document.createElement('div'); nameL.className = 'pnq-link-name'; nameL.textContent = srcName;
    gL.appendChild(iconL); gL.appendChild(nameL);

    var line = document.createElement('div'); line.className = 'pnq-link-line';
    line.innerHTML = '<span class="pnq-link-line-bar"></span>';

    var gR = document.createElement('div'); gR.className = 'pnq-link-node';
    var iconR = document.createElement('div'); iconR.className = 'pnq-link-icon';
    if (dstImg) { dstImg.className = 'pnq-link-img'; dstImg.removeAttribute('style'); iconR.appendChild(dstImg); }
    if (dstIface) { dstIface.classList.add('pnq-link-iface', 'pnq-link-iface-right'); iconR.appendChild(dstIface); }
    var nameR = document.createElement('div'); nameR.className = 'pnq-link-name'; nameR.textContent = dstName;
    gR.appendChild(iconR); gR.appendChild(nameR);

    pv.appendChild(gL); pv.appendChild(line); pv.appendChild(gR);
    body.appendChild(pv);

    /* serial-port hot-plug note, if present */
    var note = col4 && col4.querySelector('div[style*="color:red"], div[style*="color: red"]');
    if (note) { note.classList.add('pnq-link-note'); body.appendChild(note); }

    /* stacked interface pickers (skip a network endpoint — no interface) */
    var fields = document.createElement('div'); fields.className = 'pnq-link-fields';
    if (pnqLinkSelVisible(srcSel)) {
      pnqLinkOptgroup(srcSel, 'Choose Interface for Source');
      fields.appendChild(pnqLinkField('Source node (' + srcName + ')', srcSel));
    }
    if (pnqLinkSelVisible(dstSel)) {
      pnqLinkOptgroup(dstSel, 'Choose Interface for Destination');
      fields.appendChild(pnqLinkField('Destination node (' + dstName + ')', dstSel));
    }
    body.appendChild(fields);

    /* actions */
    var actions = document.createElement('div'); actions.className = 'pnq-link-actions';
    if (saveBtn) actions.appendChild(saveBtn);
    if (cancelBtn) actions.appendChild(cancelBtn);
    body.appendChild(actions);

    form.appendChild(body);
    row.style.display = 'none';                   /* hide the original layout */
    form.dataset.pnqLinkStyled = '1';
  }

  /* ── EVE-style template picker (initial Add Node state) ─────────────────────
     While no template is chosen, present the Bootstrap-Select as an inline,
     searchable, scrollable template list (EVE-NG look) by toggling `.pnq-pick`
     on the modal. Once a template is selected, drop the class so the two-column
     settings form takes over the modal.
  ──────────────────────────────────────────────────────────────────────────*/
  function fixShowAll() {
    var l = document.getElementById('form-node-showall');
    if (!l) return;
    for (var n = l.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && /unsupport/i.test(n.nodeValue) &&
          n.nodeValue.indexOf('unprovisioned') === -1) {
        n.nodeValue = ' Show unprovisioned templates';
      }
    }
  }

  /* Hide the "Nothing selected" placeholder row from the inline list */
  function hidePlaceholderRow(sel) {
    var bs = sel.parentElement && sel.parentElement.querySelector('.bootstrap-select');
    if (!bs) return;
    var rows = bs.querySelectorAll('.dropdown-menu.inner > li');
    Array.prototype.forEach.call(rows, function (li) {
      var a = li.querySelector('a .text');
      if (a && a.textContent.trim() === 'Nothing selected') {
        li.classList.add('pnq-hide-row');
      }
    });
  }

  function applyPickMode() {
    var sel = document.getElementById('form-node-template');
    if (!sel) return;
    var mc = sel.closest('.modal-content');
    var md = sel.closest('.modal-dialog');
    if (!mc) return;
    mc.classList.add('pnq-node-modal');  /* stable marker for white-glass theming */
    /* Pick-mode is ADD-only. In EDIT, an INVALID/unprovisioned image leaves
       #form-node-template empty (the template option isn't in the list), which used
       to flip picking=true and overlay the template picker ON TOP of the populated
       edit form. Editing an existing node must always show the form (with the
       in-form template dropdown available to re-pick a valid image). */
    var picking = isAddMode() && !sel.value;   /* empty value = still choosing (Add only) */
    mc.classList.toggle('pnq-pick', picking);
    if (md) md.classList.toggle('pnq-pick', picking);
    /* form mode + Add → hide the (broken) in-form template dropdown, show Back bar */
    mc.classList.toggle('pnq-formmode', !picking && isAddMode());
    fixShowAll();
    if (picking) {
      hidePlaceholderRow(sel);
      addRowIcons(sel);
      var bs = sel.parentElement && sel.parentElement.querySelector('.bootstrap-select');
      var sb = bs && bs.querySelector('.bs-searchbox input');
      if (sb && !sb.placeholder) sb.placeholder = 'Search templates…';
    }

    /* attach a one-time change listener so selecting collapses the picker */
    if (!sel.dataset.pnqPick) {
      sel.dataset.pnqPick = '1';
      sel.addEventListener('change', function () {
        setTimeout(applyPickMode, 0);
      });
    }
  }

  /* ── MutationObserver wiring ──────────────────────────────────────────── */
  var fdObs = null, timer = null;

  function hasRawGroups(fd) {
    return Array.prototype.some.call(fd.children, function (c) {
      return c.className && c.className.indexOf('col-xs-12') !== -1;
    });
  }

  function watchFormData(fd) {
    if (fdObs) fdObs.disconnect();
    fdObs = new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (hasRawGroups(fd)) organize(fd);
        addSubtext();
        applyPickMode();
        tagWhiteModals();
        prefillNodeName(fd);
      }, 0);
    });
    fdObs.observe(fd, { childList: true });
    if (hasRawGroups(fd)) { organize(fd); prefillNodeName(fd); }
  }

  var bodyObs = new MutationObserver(function () {
    var fd = document.getElementById('form-node-data');
    if (fd && !fd.dataset.pnqW) { fd.dataset.pnqW = '1'; watchFormData(fd); }
    addSubtext();
    applyPickMode();
    tagWhiteModals();
    pnqInjectPopoutBtn();
  });

  /* ── Cancel on the Add-Line bar must remove the line ────────────────────────
     PNetLab bug: clicking "Line" runs createLine() which BOTH draws the line
     AND persists it (addLine → POST /api/labs/session/line/add) *before* the
     line-style bar (.line_ctl_frame) opens. The bar's Cancel button only calls
     onCancel() → modal("hide") + printTopology(); it never deletes the line, so
     Add-then-Cancel leaves a stray line on the canvas and in the lab file.

     Fix entirely at this layer (no React-bundle edit): remember whether the bar
     was opened by an *add* (.action-lineadd) vs an *edit* (.action-lineedit),
     snapshotting the existing line ids on add. When Cancel is pressed after an
     add, diff the on-canvas line endpoints (#startLine{id}) against the snapshot
     and delete the new one via the same API the app uses (window.axios carries
     the Laravel XSRF header), then refresh through App.topology. */
  var pnqLineMode = null;          /* 'add' | 'edit' | null */
  var pnqLineSnapshot = [];        /* line ids present when an add started     */

  function pnqStartLineIds() {
    return Array.prototype.map.call(
      document.querySelectorAll('#lab-viewport [id^="startLine"]'),
      function (el) { return el.id.slice(9); }   /* "startLine".length === 9 */
    );
  }

  function pnqLineModeTracker(e) {
    if (!e.target.closest) return;
    if (e.target.closest('.action-lineadd')) {
      pnqLineMode = 'add';
      pnqLineSnapshot = pnqStartLineIds();       /* before createLine (bubble) */
    } else if (e.target.closest('.action-lineedit')) {
      pnqLineMode = 'edit';
    }
  }

  function pnqDeleteLine(id) {
    var ax = window.axios;
    function refresh(d) {
      if (window.App && App.topology) {
        if (d && d.update && App.topology.updateData) App.topology.updateData(d.update);
        if (App.topology.printTopology) App.topology.printTopology();
      }
    }
    function domRemove() {
      var s = document.getElementById('startLine' + id);
      var en = document.getElementById('endLine' + id);
      if (s) s.remove();
      if (en) en.remove();
      refresh(null);
    }
    if (ax && ax.post) {
      ax.post('/api/labs/session/line/delete', { id: id })
        .then(function (res) { refresh(res && res.data); })
        .catch(domRemove);
    } else {
      domRemove();
    }
  }

  function pnqLineCancelHandler(e) {
    if (!e.target.closest) return;
    var frame = e.target.closest('.line_ctl_frame');
    if (!frame) return;
    /* Apply (btn-primary) keeps the line — just clear the tracked mode */
    if (e.target.closest('.btn-primary')) { pnqLineMode = null; return; }
    /* Cancel is the danger button */
    if (!e.target.closest('.btn-danger')) return;
    if (pnqLineMode !== 'add') { pnqLineMode = null; return; }
    pnqLineMode = null;
    var before = {};
    pnqLineSnapshot.forEach(function (id) { before[id] = 1; });
    pnqStartLineIds().forEach(function (id) {
      if (!before[id]) pnqDeleteLine(id);        /* line created by this add */
    });
  }

  /* ── Smooth fade for the lab-open loader (#loading-lab) ─────────────────────
     lab.js toggles it with jQuery .show()/.hide() (instant → abrupt). Wrap
     those two methods ONLY for this one element so it fades via the CSS opacity
     transition; every other .show()/.hide() call passes through unchanged. */
  var PNQ_FADE_MS = 450;        /* must match CSS #loading-lab opacity transition */
  var PNQ_MIN_VISIBLE_MS = 850; /* loader stays at least this long once shown    */

  function pnqLoaderShow(el, jq, _show) {
    clearTimeout(el.__pnqHideWait);
    clearTimeout(el.__pnqHideDone);
    el.__pnqShownAt = Date.now();
    document.body.classList.add('pnq-loading');   /* hide quickbar while loading */
    _show.call(jq(el));
    /* restart the comet-sweep animation cleanly each open */
    var bar = el.querySelector('.progress-bar');
    if (bar) { bar.style.animation = 'none'; void bar.offsetHeight; bar.style.animation = ''; }
    /* fade in only if not already fully shown (avoids a snap when re-shown) */
    if (el.style.opacity !== '1') {
      el.style.opacity = '0';
      void el.offsetHeight;                   /* reflow so the transition fires */
      requestAnimationFrame(function () { el.style.opacity = '1'; });
    }
  }

  function pnqLoaderHide(el, jq, _hide) {
    clearTimeout(el.__pnqHideWait);
    clearTimeout(el.__pnqHideDone);
    var elapsed = Date.now() - (el.__pnqShownAt || 0);
    var wait = Math.max(0, PNQ_MIN_VISIBLE_MS - elapsed);   /* enforce min visible */
    el.__pnqHideWait = setTimeout(function () {
      el.style.opacity = '0';                 /* smooth fade out via CSS transition */
      el.__pnqHideDone = setTimeout(function () {
        _hide.call(jq(el));
        el.style.opacity = '';
        /* loader fully gone — now let the quickbar fade in */
        document.body.classList.remove('pnq-loading');
      }, PNQ_FADE_MS);
    }, wait);
  }

  /* Wrap jQuery .show()/.hide() ONLY for #loading-lab so it fades and is shown
     for a guaranteed minimum time (lab.js calls show() then hide() within a few
     ms on localhost → without the floor it just flickers). Every other call
     passes straight through. Exposes window.__pnqLoaderShow for the close-lab
     transition (newUIreturn navigates to "/" so we fade the loader in first). */
  function patchLoaderFade() {
    var jq = window.jQuery || window.$;
    if (!jq || !jq.fn || jq.fn.__pnqLoaderPatched) return !!(jq && jq.fn);
    jq.fn.__pnqLoaderPatched = true;
    var _show = jq.fn.show, _hide = jq.fn.hide;
    function isLoader(o) { return o.length === 1 && o[0] && o[0].id === 'loading-lab'; }
    jq.fn.show = function () {
      if (isLoader(this)) { pnqLoaderShow(this[0], jq, _show); return this; }
      return _show.apply(this, arguments);
    };
    jq.fn.hide = function () {
      if (isLoader(this)) { pnqLoaderHide(this[0], jq, _hide); return this; }
      return _hide.apply(this, arguments);
    };
    window.__pnqLoaderShow = function () {
      var el = document.getElementById('loading-lab');
      if (el) pnqLoaderShow(el, jq, _show);
    };
    /* fade in the loader if it's already visible on initial page load */
    var el = document.getElementById('loading-lab');
    if (el && getComputedStyle(el).display !== 'none') {
      el.__pnqShownAt = Date.now();
      document.body.classList.add('pnq-loading');   /* keep quickbar hidden until loader done */
      el.style.opacity = '0';
      void el.offsetHeight;
      requestAnimationFrame(function () { el.style.opacity = '1'; });
    }
    return true;
  }

  /* ── Icon picker → inline white-glass dropdown ──────────────────────────────
     The Add Node "Icon" field (a .form-control.box_flex.button rendered by React)
     normally opens PNetLab's green file-manager modal via the global
     selectImage(cb), where cb(filename) does state.node.icon=filename + setState
     (exactly what Save reads). We override window.selectImage so that click
     instead captures cb and opens our own dropdown — white-glass to match the
     modal — listing every icon alphabetically with a preview. Picking one calls
     cb(name), so React state + Save stay correct. Icons come from the engine
     shim (POST /images-icons/api.php?action=scan). No PNetLab-core edits.
     (selectImage is called from exactly one place — the Add Node icon field — so
     this override affects nothing else.) */
  var pnqIconCb = null, pnqIconList = null, pnqIconLoading = false;
  /* Tracks the most-recently-clicked bulk-panel icon button so pnqFindIconControl()
     can use it as the anchor when invoked from bulk-edit mode (no modal present). */
  var pnqBulkIconBtn = null;
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.pnq-bulk-iconbtn') : null;
    if (btn) pnqBulkIconBtn = btn;
  }, true);

  function pnqInstallIconPicker() {
    if (window.__pnqSelImgPatched) return;
    try {
      Object.defineProperty(window, 'selectImage', {
        configurable: true,
        get: function () { return pnqSelectImage; },
        set: function () { /* ignore PNetLab's modal-opener; we replace it */ }
      });
      window.__pnqSelImgPatched = true;
    } catch (e) { /* if it can't be redefined, PNetLab's modal stays */ }
  }
  function pnqSelectImage(cb) {                 /* invoked by the icon field onClick */
    pnqIconCb = (typeof cb === 'function') ? cb : null;
    if (window.__pnqModalNext) { window.__pnqModalNext = false; pnqOpenIconModal(); }
    else { pnqOpenIconDD(); }
  }

  function pnqEnsureIconDD() {
    var dd = document.getElementById('pnq-icon-dd');
    if (dd) return dd;
    dd = mk('div', 'pnq-icon-dd'); dd.id = 'pnq-icon-dd';
    dd.innerHTML = '<input type="text" class="pnq-icon-search" placeholder="Search icons…" autocomplete="off">' +
                   '<div class="pnq-icon-list"></div>';
    document.body.appendChild(dd);
    dd.querySelector('.pnq-icon-search').addEventListener('input', function () {
      pnqRenderIconRows(this.value.trim().toLowerCase());
    });
    document.addEventListener('mousedown', function (e) {
      var d = document.getElementById('pnq-icon-dd');
      if (d && d.classList.contains('pnq-open') && !d.contains(e.target)) pnqCloseIconDD();
    }, true);
    /* The Add Network modal is a jQuery Bootstrap modal with enforceFocus — its
       document focusin handler refocuses the modal whenever focus moves outside
       it, which would steal focus from our body-appended search box (so typing
       did nothing). Swallow focusin in capture phase while focus is inside our
       dropdown, so Bootstrap's handler never runs and the search keeps focus. */
    document.addEventListener('focusin', function (e) {
      var d = document.getElementById('pnq-icon-dd');
      if (d && d.classList.contains('pnq-open') && d.contains(e.target)) e.stopImmediatePropagation();
    }, true);
    window.addEventListener('resize', pnqCloseIconDD);
    return dd;
  }
  function pnqFindIconControl() {
    /* Add Network modal: the icon selector wraps #networkimage_preview */
    var npv = document.getElementById('networkimage_preview');
    if (npv) { var nb = npv.closest('.button, .selectpicker, .form-control'); if (nb) return nb; }
    /* Add Node modal: the .button control next to the "Icon" label */
    var ctl = null;
    document.querySelectorAll('.pnq-node-modal label, .pnq-node-modal .control-label').forEach(function (l) {
      if (l.textContent.trim().toLowerCase() === 'icon' && l.parentElement) {
        var c = l.parentElement.querySelector('.button, .form-control');
        if (c) ctl = c;
      }
    });
    if (ctl) return ctl;
    /* Bulk-edit panel: no modal is present; fall back to the last-clicked
       .pnq-bulk-iconbtn so the dropdown anchors to the button itself. */
    if (pnqBulkIconBtn && document.contains(pnqBulkIconBtn)) return pnqBulkIconBtn;
    return null;
  }
  function pnqOpenIconDD() {
    var dd = pnqEnsureIconDD();
    var ctl = pnqFindIconControl(); if (!ctl) return;
    /* match the dropdown to the field column (the control itself can be a
       shrink-to-content box_flex), so it lines up with the other inputs */
    var box = ctl.closest('.col-md-5') || ctl.closest('.pnq-field-container') || ctl;
    var br = box.getBoundingClientRect(), cr = ctl.getBoundingClientRect();
    dd.style.left = Math.round(br.left) + 'px';
    dd.style.top = Math.round(cr.bottom + 4) + 'px';
    dd.style.width = Math.max(240, Math.round(br.width)) + 'px';
    /* The Add Node modal is re-homed to <body> and lifted above the web-console
       backdrop (z~100039–100041; see pnetlab-webconsole.js modal floor). The CSS
       gives this dropdown z-index:10050, which now sits BELOW the modal — so it
       opened hidden behind it. Pin it above the modal floor so it overlays. */
    dd.style.zIndex = '100060';
    dd.classList.add('pnq-open');
    /* Bootstrap 3 modal enforceFocus (jQuery focusin.bs.modal, bound capture-phase)
       refocuses the modal whenever focus moves outside it, stealing focus from
       our body-appended search box. Remove that handler while the dropdown is
       open so the search input stays focusable (harmless: the modal re-binds it
       on its next show). React modals (Add Node) have no such handler. */
    if (window.jQuery) { try { window.jQuery(document).off('focusin.bs.modal'); } catch (e) {} }
    var s = dd.querySelector('.pnq-icon-search'); s.value = '';
    if (pnqIconList) { pnqRenderIconRows(''); s.focus(); }
    else {
      dd.querySelector('.pnq-icon-list').innerHTML = '<div class="pnq-icon-empty">Loading icons…</div>';
      pnqLoadIcons(function () { var d = document.getElementById('pnq-icon-dd'); if (d && d.classList.contains('pnq-open')) { pnqRenderIconRows(''); s.focus(); } });
    }
  }
  function pnqCloseIconDD() { var dd = document.getElementById('pnq-icon-dd'); if (dd) dd.classList.remove('pnq-open'); }

  function pnqLoadIcons(done) {
    if (pnqIconLoading) return;
    pnqIconLoading = true;
    fetch('/images-icons/api.php?action=scan', { method: 'POST', credentials: 'same-origin',
           headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var arr = (d && (d.data || d.files)) || [];
        if (!Array.isArray(arr)) arr = [];
        arr.sort(function (a, b) { return String(a).toLowerCase().localeCompare(String(b).toLowerCase()); });
        pnqIconList = arr; pnqIconLoading = false; if (done) done();
      })
      .catch(function () {
        pnqIconLoading = false;
        var dd = document.getElementById('pnq-icon-dd');
        if (dd) dd.querySelector('.pnq-icon-list').innerHTML = '<div class="pnq-icon-empty">Could not load icons.</div>';
      });
  }
  function pnqRenderIconRows(q) {
    var dd = document.getElementById('pnq-icon-dd'); if (!dd) return;
    var list = dd.querySelector('.pnq-icon-list');
    var items = (pnqIconList || []).filter(function (n) { return !q || String(n).toLowerCase().indexOf(q) !== -1; });
    if (!items.length) { list.innerHTML = '<div class="pnq-icon-empty">No matching icons.</div>'; return; }
    var frag = document.createDocumentFragment();
    items.slice(0, 400).forEach(function (name) {
      var row = mk('div', 'pnq-icon-row'); row.dataset.icon = name;
      row.innerHTML = '<img loading="lazy" src="/images/icons/' + encodeURIComponent(name) + '"><span>' + name + '</span>';
      row.addEventListener('click', function () { pnqPickIcon(name); });
      frag.appendChild(row);
    });
    list.innerHTML = ''; list.appendChild(frag);
    if (items.length > 400) {
      var more = mk('div', 'pnq-icon-empty'); more.textContent = '… ' + (items.length - 400) + ' more — type to filter';
      list.appendChild(more);
    }
  }
  function pnqPickIcon(name) {
    if (pnqIconCb) { try { pnqIconCb(name); } catch (e) {} }
    pnqCloseIconDD();
  }

  /* ── Icon picker — wide grid pop-out modal ────────────────────────────────
     A small expand button injected next to the Icon field opens a centred
     wide modal with a searchable grid (large tile per icon). Shares the same
     pnqIconCb / pnqIconList / pnqLoadIcons machinery as the dropdown.
     window.__pnqModalNext is a one-shot flag: set before calling ctl.click()
     so pnqSelectImage routes to the modal instead of the dropdown. */

  function pnqInjectIconModalCSS() {
    if (document.getElementById('pnq-icon-modal-css')) return;
    var s = document.createElement('style');
    s.id = 'pnq-icon-modal-css';
    s.textContent =
      /* Wrapper div that holds ctl + popout btn in a flex row */
      '.pnq-icon-field-wrap{display:flex!important;align-items:center!important;gap:6px!important;width:100%!important}' +
      '.pnq-icon-field-wrap>.form-control,.pnq-icon-field-wrap>.button{flex:1 1 auto!important;min-width:0!important}' +
      '.pnq-icon-popout-btn{flex:0 0 auto;align-self:stretch;padding:0 8px;' +
        'display:flex;align-items:center;justify-content:center;' +
        'border:1px solid rgba(0,0,0,.15);border-radius:7px;' +
        'background:rgba(255,255,255,.8);cursor:pointer;font-size:13px;color:#3c708a;line-height:1;' +
        'transition:background .15s,border-color .15s}' +
      '.pnq-icon-popout-btn:hover{background:rgba(60,112,138,.14);border-color:rgba(60,112,138,.4)}' +
      /* Overlay backdrop */
      '.pnq-icon-modal-ov{display:none;position:fixed;inset:0;z-index:100070;' +
        'background:rgba(0,0,0,.48);align-items:center;justify-content:center;' +
        '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}' +
      '.pnq-icon-modal-ov.pnq-open{display:flex}' +
      /* Modal shell — white glass, same width as Add Node modal */
      '.pnq-icon-modal{width:min(1200px,92vw);height:min(700px,88vh);' +
        'background:rgba(255,255,255,.92);' +
        '-webkit-backdrop-filter:blur(30px) saturate(180%);backdrop-filter:blur(30px) saturate(180%);' +
        'border:1px solid rgba(255,255,255,.65);' +
        'box-shadow:inset 0 1px 0 rgba(255,255,255,.7),0 24px 64px rgba(0,0,0,.28);' +
        'border-radius:10px;display:flex;flex-direction:column;overflow:hidden;' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
        '-webkit-font-smoothing:antialiased}' +
      /* Header — frosted white, dark text, matches pnq-node-modal .modal-header */
      '.pnq-icon-modal-head{display:flex;align-items:center;gap:10px;padding:12px 16px;' +
        'background:rgba(255,255,255,.30);border-bottom:1px solid rgba(0,0,0,.10);flex:0 0 auto}' +
      '.pnq-icon-modal-title{font-size:15px;font-weight:500;color:#1d1d1f;flex:0 0 auto;margin-right:4px}' +
      /* This body-level white-glass search input must beat the body.pnq-dark
         input[type=text] global in assets-common/css/pnetlab-enhance-v2.css:4965-4974. */
      '.pnq-icon-modal-search{flex:1 1 auto;min-width:0;padding:5px 10px;font-size:13px;' +
        'border:1px solid rgba(0,0,0,.15) !important;border-radius:6px;background:rgba(255,255,255,.8) !important;color:#1d1d1f !important}' +
      '.pnq-icon-modal-search::placeholder{color:rgba(0,0,0,.35)}' +
      '.pnq-icon-modal-search:focus{outline:none;border-color:rgba(60,112,138,.5) !important;background:#fff !important}' +
      '.pnq-icon-modal-x{flex:0 0 auto;background:none;border:none;color:#1d1d1f;' +
        'font-size:22px;line-height:1;cursor:pointer;padding:0 2px;opacity:.5}' +
      '.pnq-icon-modal-x:hover{opacity:1}' +
      /* Icon grid */
      '.pnq-icon-modal-grid{flex:1 1 auto;overflow-y:auto;padding:14px;' +
        'display:flex;flex-wrap:wrap;align-content:flex-start;gap:6px}' +
      '.pnq-icon-tile{width:110px;padding:8px 6px 6px;border-radius:8px;cursor:pointer;' +
        'display:flex;flex-direction:column;align-items:center;gap:5px;' +
        'border:1px solid transparent;transition:background .12s,border-color .12s}' +
      '.pnq-icon-tile:hover{background:rgba(60,112,138,.10);border-color:rgba(60,112,138,.28)}' +
      '.pnq-icon-tile img{width:56px;height:56px;object-fit:contain}' +
      '.pnq-icon-tile span{font-size:10px;color:#1d1d1f;text-align:center;word-break:break-all;' +
        'line-height:1.3;max-height:2.7em;overflow:hidden}' +
      '.pnq-icon-modal-grid::-webkit-scrollbar{width:8px}' +
      '.pnq-icon-modal-grid::-webkit-scrollbar-thumb{background:rgba(60,112,138,.3);border-radius:5px}';
    document.head.appendChild(s);
  }

  function pnqInjectPopoutBtn() {
    /* One button per page — if one already exists anywhere, the modal is already
       set up (either this open or a re-fire from a DOM mutation). */
    if (document.querySelector('.pnq-icon-popout-btn')) return;
    var ctl = pnqFindIconControl();
    if (!ctl) return;
    var btn = mk('button', 'pnq-icon-popout-btn');
    btn.type = 'button';
    btn.title = 'Browse all icons';
    btn.innerHTML = '<i class="glyphicon glyphicon-resize-full"></i>';
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      /* Route next selectImage(cb) call → modal instead of dropdown */
      window.__pnqModalNext = true;
      try { ctl.click(); } catch (_) {}
      window.__pnqModalNext = false;
      /* Fallback: if ctl.click() didn't fire selectImage, open directly */
      var ov = document.getElementById('pnq-icon-modal-ov');
      if (!ov || !ov.classList.contains('pnq-open')) pnqOpenIconModal();
    });
    /* Wrap ctl and the button together in a flex row div so they sit side-by-side
       regardless of what CSS the parent container applies to its children. */
    var wrap = mk('div', 'pnq-icon-field-wrap');
    ctl.parentNode.insertBefore(wrap, ctl);
    wrap.appendChild(ctl);
    wrap.appendChild(btn);
  }

  function pnqEnsureIconModal() {
    var ov = document.getElementById('pnq-icon-modal-ov');
    if (ov) return ov;
    ov = mk('div', 'pnq-icon-modal-ov'); ov.id = 'pnq-icon-modal-ov';
    ov.innerHTML =
      '<div class="pnq-icon-modal">' +
        '<div class="pnq-icon-modal-head">' +
          '<span class="pnq-icon-modal-title">Device Icons</span>' +
          '<input type="text" class="pnq-icon-modal-search" placeholder="Search icons…" autocomplete="off">' +
          '<button class="pnq-icon-modal-x" title="Close">&times;</button>' +
        '</div>' +
        '<div class="pnq-icon-modal-grid"></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.querySelector('.pnq-icon-modal-x').addEventListener('click', pnqCloseIconModal);
    ov.addEventListener('click', function (e) { if (e.target === ov) pnqCloseIconModal(); });
    ov.querySelector('.pnq-icon-modal-search').addEventListener('input', function () {
      pnqRenderIconModalGrid(this.value.trim().toLowerCase());
    });
    /* Keep focus inside the modal (same Bootstrap-enforceFocus fix as the dropdown) */
    document.addEventListener('focusin', function (e) {
      var o = document.getElementById('pnq-icon-modal-ov');
      if (o && o.classList.contains('pnq-open') && o.contains(e.target)) e.stopImmediatePropagation();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var o = document.getElementById('pnq-icon-modal-ov');
      if (o && o.classList.contains('pnq-open')) pnqCloseIconModal();
    });
    return ov;
  }

  function pnqOpenIconModal() {
    pnqCloseIconDD();
    var ov = pnqEnsureIconModal();
    ov.classList.add('pnq-open');
    if (window.jQuery) { try { window.jQuery(document).off('focusin.bs.modal'); } catch (e) {} }
    var s = ov.querySelector('.pnq-icon-modal-search'); s.value = '';
    if (pnqIconList) { pnqRenderIconModalGrid(''); s.focus(); }
    else {
      ov.querySelector('.pnq-icon-modal-grid').innerHTML =
        '<div style="width:100%;padding:40px;text-align:center;color:#86868b;font-size:13px">Loading icons…</div>';
      pnqLoadIcons(function () {
        var o = document.getElementById('pnq-icon-modal-ov');
        if (o && o.classList.contains('pnq-open')) { pnqRenderIconModalGrid(''); s.focus(); }
      });
    }
  }

  function pnqCloseIconModal() {
    var ov = document.getElementById('pnq-icon-modal-ov');
    if (ov) ov.classList.remove('pnq-open');
  }

  function pnqRenderIconModalGrid(q) {
    var ov = document.getElementById('pnq-icon-modal-ov'); if (!ov) return;
    var grid = ov.querySelector('.pnq-icon-modal-grid');
    var items = (pnqIconList || []).filter(function (n) { return !q || String(n).toLowerCase().indexOf(q) !== -1; });
    if (!items.length) {
      grid.innerHTML = '<div style="width:100%;padding:40px;text-align:center;color:#86868b;font-size:13px">No matching icons.</div>';
      return;
    }
    var frag = document.createDocumentFragment();
    items.forEach(function (name) {
      var tile = mk('div', 'pnq-icon-tile');
      tile.innerHTML = '<img loading="lazy" src="/images/icons/' + encodeURIComponent(name) + '"><span>' + name + '</span>';
      tile.addEventListener('click', function () {
        if (pnqIconCb) { try { pnqIconCb(name); } catch (e2) {} }
        pnqCloseIconModal();
      });
      frag.appendChild(tile);
    });
    grid.innerHTML = ''; grid.appendChild(frag);
  }

  function init() {
    /* Earliest possible: if the loader is already on-screen at page load, mark
       the body so the quickbar stays hidden even before jQuery is patched
       (prevents a quickbar flash before the loader fade completes). */
    var _ld = document.getElementById('loading-lab');
    if (_ld && getComputedStyle(_ld).display !== 'none') {
      document.body.classList.add('pnq-loading');
    }
    /* Keep body.pnq-loading (which pins #pnetlab-quickbar to opacity:0) in sync with
       the loader's REAL visibility. The canvas-flow island hides #loading-lab by
       setting display:none DIRECTLY (main.js hideLoadingOverlay, !important) to skip
       the fade — it deliberately bypasses the jQuery .hide() wrapper below, so
       pnqLoaderHide()'s body.classList.remove('pnq-loading') never fires and the
       quickbar would stay invisible forever (regression from the load-flicker fix).
       Observe the single loader element: the instant it goes display:none by ANY
       path, drop pnq-loading so the quickbar fades in. Harmless/redundant on the
       jQuery-fade path (which also clears the class). */
    if (_ld) {
      var _ldObs = new MutationObserver(function () {
        if (getComputedStyle(_ld).display === 'none') {
          document.body.classList.remove('pnq-loading');
        }
      });
      _ldObs.observe(_ld, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    bodyObs.observe(document.body, { childList: true, subtree: true });
    pnqInstallIconPicker();   /* replace the green icon modal with our dropdown */
    pnqInjectIconModalCSS();  /* inject pop-out modal styles */
    /* Track add/edit on the line bar (capture: runs before createLine in the
       bubble-phase jQuery handler, so the snapshot precedes line creation). */
    document.addEventListener('click', pnqLineModeTracker, true);
    /* Delete the just-added line if Cancel is pressed (capture: runs before
       React's onCancel/printTopology). */
    document.addEventListener('click', pnqLineCancelHandler, true);
    /* Lab CLOSE navigates to "/" (newUIreturn) immediately — fade the loader in
       first so the exit matches the lab-open transition. NOTE: .action-labdestroy
       is deliberately NOT here — destroy now shows a confirm modal first, so
       showing the loader on the click stranded it at the splash when the user
       hit Cancel. The destroy loader is shown on CONFIRM instead (actions.js). */
    document.addEventListener('click', function (e) {
      if (e.target.closest &&
          e.target.closest('.action-labclose') &&
          typeof window.__pnqLoaderShow === 'function') {
        window.__pnqLoaderShow();
      }
    }, true);
    /* Quickbar "Add Node": the add handler positions the new node at
       contextClickXY (last canvas right-click) or, with none, at (0,0) = hidden
       top-left behind the quickbar. Pre-seed a visible centre-ish spot so it
       drops where it's easy to spot. (Network/Picture/Text/Line were removed
       from the quickbar — they're added via canvas right-click, which sets
       contextClickXY at the cursor, so only the kept Add Node needs this.)
       capture: runs before actions.js reads it. */
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.pnq-btn.action-nodeplace') && window.jQuery) {
        var x = Math.round(window.innerWidth * 0.5);
        var y = Math.round(window.innerHeight * 0.45);
        try { window.jQuery('#lab-viewport').data('contextClickXY', { x: x, y: y }); } catch (e2) {}
      }
    }, true);
    /* jQuery may load slightly after this script — retry briefly */
    if (!patchLoaderFade()) {
      var t = setInterval(function () { if (patchLoaderFade()) clearInterval(t); }, 50);
      setTimeout(function () { clearInterval(t); }, 6000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ===== EVE-NG link hover — proximity trigger (2026-06-03, fixed 2026-06-03) =====
   jsPlumb only hit-tests the ~2px connector line, so .jtk-hover fires in a tiny
   band. This widens it: on mousemove find the nearest connector and, if the
   cursor is within its band, tag it .pnq-link-near (CSS gives it the same
   bold+glow as .jtk-hover). Node links use BAND px; custom lines (sym_*) get a
   slightly larger LINE_BAND. Recomputed each frame (survives jsPlumb repaints);
   nearest-only so just one lights at a time. */
(function pnqLinkProximity(){
  var BAND = 12;            // node links: px on each side of the line
  var LINE_BAND = 18;       // custom lines (sym_*): a touch wider
  var raf = 0, cx = 0, cy = 0, near = null;
  function distSeg(px,py,x1,y1,x2,y2){
    var dx=x2-x1, dy=y2-y1, l2=dx*dx+dy*dy;
    if(l2===0) return Math.hypot(px-x1,py-y1);
    var t=((px-x1)*dx+(py-y1)*dy)/l2; t=t<0?0:t>1?1:t;
    return Math.hypot(px-(x1+t*dx), py-(y1+t*dy));
  }
  function minDist(conn, band){
    var path=conn.querySelector("path"); if(!path) return 1e9;
    var r=conn.getBoundingClientRect();
    if(cx<r.left-band||cx>r.right+band||cy<r.top-band||cy>r.bottom+band) return 1e9; // cheap prefilter
    var L=path.getTotalLength(); if(!L) return 1e9;
    var m=path.getScreenCTM(); if(!m) return 1e9;
    var N=Math.max(8, Math.min(64, Math.round(L/6))), min=1e9, px0, py0;
    for(var i=0;i<=N;i++){
      var pt=path.getPointAtLength(L*i/N);
      var sx=pt.x*m.a+pt.y*m.c+m.e, sy=pt.x*m.b+pt.y*m.d+m.f;
      if(i>0){ var d=distSeg(cx,cy,px0,py0,sx,sy); if(d<min) min=d; }
      px0=sx; py0=sy;
    }
    return min;
  }
  function update(){
    raf=0;
    var conns=document.querySelectorAll("svg.jtk-connector");
    var best=null, bestD=Infinity;
    for(var i=0;i<conns.length;i++){
      var c=conns[i];
      var band=/(^|\s)sym_/.test(c.getAttribute("class")||"") ? LINE_BAND : BAND;
      var d=minDist(c, band);
      if(d<=band && d<bestD){ bestD=d; best=c; }
    }
    if(best!==near){
      if(near) near.classList.remove("pnq-link-near");
      if(best) best.classList.add("pnq-link-near");
      near=best;
    }
  }
  document.addEventListener("mousemove", function(e){
    cx=e.clientX; cy=e.clientY;
    if(!raf) raf=requestAnimationFrame(update);
  }, true);
})();
