// pnetlab-webconsole.js
// Opt-in launcher for the GNS3-style tabbed web console (Slice 1: telnet lane).
//
// Sits NEXT TO the existing Guacamole console — Guacamole stays the default.
// The Quick Bar "Web Console" button opens the console in one of two persisted
// modes (default = in-lab):
//   * "in-lab"  — a draggable/resizable floating window INSIDE the topology
//                 page hosting /console/console.html in a same-origin iframe.
//   * "new tab" — opens /console/console.html in a separate browser tab.
//
// SIDE-BY-SIDE: multiple in-lab windows are supported. The main window holds
// the node list + tabs; any node can also be DETACHED into its own in-lab
// window (the node list's "↗ own window" action calls pnqDetachWebConsole()).
// New windows cascade so they're easy to drag side by side. Each per-node
// window is keyed by node id (re-detaching the same node just raises it) and
// titled with the node name (the iframe postMessages it up).
//
// Self-contained, additive script (registered in themes/default/index.html);
// no edits to the minified engine code.
(function () {
  'use strict';

  var CONSOLE_URL = '/console/console.html';
  var WIN_CLASS = 'pnq-wc-win';
  var STYLE_ID = 'pnq-webconsole-style';
  var MODE_KEY  = 'pnq_wc_mode';            // 'embed' (default) | 'tab'
  var STATE_PREFIX = 'pnq_wc_open_v1:';    // sessionStorage: open windows (survive refresh)
  // Scoped by lab id, fetched once here rather than read off window.lab: that
  // legacy global is set by getLabInfo() (api/labs.js) but is NOT reliably
  // populated on the canvas-flow lab page — canvas-flow/api-seed.js's
  // normalizeLabinfo() deliberately keeps only {lock, editable} from the
  // topology response and drops `id` (see its comment: "window.lab is NOT
  // reliably populated on the canvas-flow lab page ... never re-hydrates the
  // legacy global"). A flat unscoped key would replay a PREVIOUS lab's cached
  // window titles/node-type badges onto whatever now occupies the same node
  // id in a different lab (node ids are allocated per-lab and reused — see
  // console-tabs.js's matching scrollback-cache fix).
  //
  // stateKey() returns null (skip save/restore, fail closed) until the id is
  // known. _labIdPromise is exposed alongside the cached _labId so
  // restoreOpenConsoles() can actually WAIT for it (bounded at 3s — see
  // init()) instead of just sampling whatever's resolved at a fixed 600ms
  // mark: an earlier version of this fix sampled only, which meant a slow
  // fetch (page under load) made restore silently no-op for that load AND
  // then the next unload's saveOpenConsoles() would overwrite the
  // still-valid saved state with the now-current (empty) window list —
  // quietly losing it. Waiting on the promise narrows that race to the tail
  // case where the fetch is still unresolved past the 3s cap (a genuinely
  // hung/very slow request) — it does not eliminate it outright, since
  // capping is unavoidable: an uncapped wait risks restore never firing at
  // all on a request that never resolves. That residual tail is accepted;
  // uncapping is not an improvement.
  //
  // Residual, NOT fixed here: /api/labs/session/info resolves against the
  // account's server-side "current lab" pointer (users.lab_session), which is
  // shared across every tab for that account, not pinned per browser tab. If
  // a second tab switches the account to a different lab while this fetch is
  // in flight, _labId can resolve to the WRONG (new) lab. This is not a
  // regression from this fix: token_mint.php's open_user_lab() — which
  // authorizes the actual live console connection — reads that exact same
  // mutable pointer at connect/reconnect time (freshly per request, not
  // PHP-session-cached), so the live console has the same underlying
  // exposure today. It's not a byte-identical race window, though (adversarial
  // review caught this nuance): this fetch and a token mint are two
  // INDEPENDENT requests that can sample the pointer at different times, so
  // the cache's chosen lab id and the live connection's actual target can
  // disagree without needing a single shared instant of drift — either one
  // can land on either side of an intervening lab switch. Properly closing it
  // would mean deriving the scrollback/state lab id from the token-mint
  // response itself (the same resolution point that gates the live
  // connection) instead of a separate fetch — a larger change than this
  // fix's scope.
  var _labId = null;
  var _labIdPromise = fetch('/api/labs/session/info', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (j && j.status === 'success' && j.data && j.data.id) _labId = String(j.data.id);
      return _labId;
    })
    .catch(function () { return null; });
  function stateKey() {
    return _labId ? (STATE_PREFIX + _labId) : null;
  }
  // Drop sessionStorage entries left behind by OTHER labs visited earlier in
  // this same tab (each lab switch here is a full page reload, so _labId
  // resets and a naive per-lab key scheme would accumulate one entry per lab
  // ever visited in the tab's lifetime — unbounded over a long multi-lab
  // session, which this training/lab platform's normal usage pattern makes a
  // real, not hypothetical, growth path). Keeps only the current lab's key.
  function pruneOtherLabState(currentKey) {
    try {
      for (var i = sessionStorage.length - 1; i >= 0; i--) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf(STATE_PREFIX) === 0 && k !== currentKey) sessionStorage.removeItem(k);
      }
    } catch (e) {}
  }
  // Console windows live in a CAPPED band below the modal floor so a right-click
  // modal (add-node, etc.) always renders ABOVE the console (see the observer at
  // the bottom of this file). raise() climbs but never crosses WIN_CEILING.
  var WIN_BASE = 80000, WIN_CEILING = 90000;
  var MODAL_BACKDROP_Z = 99999, zModal = 100000;
  var zTop = WIN_BASE;
  var THEME_VARS = [
    '--pnq-canvas-bg', '--pnq-panel-bg', '--pnq-panel-fg', '--pnq-panel-border',
    '--pnq-head-bg', '--pnq-hover-bg', '--pnq-fg-strong', '--pnq-fg-dim', '--pnq-accent'
  ];
  var themeObserver = null;

  function getMode() { return localStorage.getItem(MODE_KEY) === 'tab' ? 'tab' : 'embed'; }
  function setMode(m) { localStorage.setItem(MODE_KEY, m === 'tab' ? 'tab' : 'embed'); applyToggleIcon(); }


  function consoleUrl(nodeId) {
    return (nodeId != null && nodeId !== '')
      ? CONSOLE_URL + '?node=' + encodeURIComponent(nodeId) + '&type=telnet'
      : CONSOLE_URL;
  }
  // 'main' window has a stable id; per-node windows are keyed by node id.
  function winIdFor(nodeId) {
    return (nodeId != null && nodeId !== '') ? 'pnq-wc-win-n' + nodeId : 'pnq-webconsole-win';
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  /* ── new-tab mode ──────────────────────────────────────────────────────────── */
  function openTabUrl(name, url) {
    var w = window.open(url, name);
    if (w) { try { w.focus(); } catch (e) {} }
  }
  function openInTab(nodeId) {
    openTabUrl(nodeId ? 'pnet-wc-n' + nodeId : 'pnet-wc-main', consoleUrl(nodeId));
  }

  /* ── in-lab floating window ────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) {
      ensureThemeSync();
      return;
    }
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
       '.' + WIN_CLASS + '{position:fixed;top:80px;left:50%;width:760px;height:520px;' +
       'margin-left:-380px;min-width:380px;min-height:220px;z-index:' + zTop + ';' +
       '--pnq-canvas-bg:#f6f8fa;--pnq-panel-bg:#fff;--pnq-panel-fg:#24292f;' +
       '--pnq-panel-border:#d0d7de;--pnq-head-bg:#f5f5f5;--pnq-hover-bg:#eaeef2;' +
       '--pnq-fg-strong:#1f2328;--pnq-fg-dim:#57606a;--pnq-accent:#3c708a;' +
       'display:flex;flex-direction:column;background:var(--pnq-panel-bg);border:1px solid var(--pnq-accent);' +
       'border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.55);overflow:hidden;}' +
       'body.pnq-dark .' + WIN_CLASS + '{--pnq-canvas-bg:#1e1e1e;--pnq-panel-bg:#21262d;' +
       '--pnq-panel-fg:#c9d1d9;--pnq-panel-border:#444c56;--pnq-head-bg:#1c2128;' +
       '--pnq-hover-bg:#30363d;--pnq-fg-strong:#f0f6fc;--pnq-fg-dim:#8b949e;--pnq-accent:#6ba3bf;}' +
      // Resize handles: 8 transparent hit-targets overlaid on the window edges.
      // They sit OUTSIDE overflow:hidden via negative inset so they don't clip.
      '.pnq-rh{position:absolute;z-index:10;touch-action:none;}' +
      '.pnq-rh-n {top:-4px;left:8px;right:8px;height:8px;cursor:n-resize;}' +
      '.pnq-rh-s {bottom:-4px;left:8px;right:8px;height:8px;cursor:s-resize;}' +
      '.pnq-rh-w {left:-4px;top:8px;bottom:8px;width:8px;cursor:w-resize;}' +
      '.pnq-rh-e {right:-4px;top:8px;bottom:8px;width:8px;cursor:e-resize;}' +
      '.pnq-rh-nw{top:-5px;left:-5px;width:14px;height:14px;cursor:nw-resize;}' +
      '.pnq-rh-ne{top:-5px;right:-5px;width:14px;height:14px;cursor:ne-resize;}' +
      '.pnq-rh-sw{bottom:-5px;left:-5px;width:14px;height:14px;cursor:sw-resize;}' +
      '.pnq-rh-se{bottom:-5px;right:-5px;width:14px;height:14px;cursor:se-resize;}' +
       // Title bar: glassy translucent (matches the app topbar .menu) instead of flat green.
       '.' + WIN_CLASS + ' .pnq-wc-bar{position:relative;flex:0 0 auto;display:flex;align-items:center;gap:8px;' +
       'height:34px;padding:0 10px;color:var(--pnq-panel-fg);cursor:move;' +
       'background:var(--pnq-head-bg);-webkit-backdrop-filter:blur(18px) saturate(180%);' +
       'backdrop-filter:blur(18px) saturate(180%);' +
       'border-bottom:1px solid var(--pnq-panel-border);' +
       'box-shadow:0 1px 0 rgba(255,255,255,.07) inset,0 4px 24px rgba(0,0,0,.30);' +
      'font:13px/1 system-ui,sans-serif;user-select:none;}' +
      // Top-lit horizontal sheen (bright top -> fade down), like .menu::before.
      '.' + WIN_CLASS + ' .pnq-wc-bar::before{content:"";position:absolute;inset:0;pointer-events:none;z-index:0;' +
      'background:linear-gradient(180deg,rgba(255,255,255,.08) 0%,rgba(255,255,255,.02) 60%,rgba(0,0,0,.04) 100%);}' +
      '.' + WIN_CLASS + ' .pnq-wc-bar > *{position:relative;z-index:1;}' +
      '.' + WIN_CLASS + ' .pnq-wc-title{flex:1 1 auto;font-weight:600;overflow:hidden;' +
      'white-space:nowrap;text-overflow:ellipsis;}' +
      '.' + WIN_CLASS + ' .pnq-wc-btn{flex:0 0 auto;min-width:22px;height:22px;line-height:22px;' +
      'text-align:center;padding:0 6px;border-radius:4px;cursor:pointer;color:var(--pnq-panel-fg);}' +
      '.' + WIN_CLASS + ' .pnq-wc-btn:hover{background:rgba(255,255,255,.12);}' +
      '.' + WIN_CLASS + ' .pnq-wc-close:hover{background:#a33;color:#fff;}' +
       '.' + WIN_CLASS + ' iframe{flex:1 1 auto;width:100%;border:0;background:var(--pnq-canvas-bg);}' +
      // Bottom-left taskbar of MINIMIZED windows (guacamole-style). Newest stacks
      // ON TOP via column-reverse, so entries grow upward from the bottom edge.
      // Sits above the console band (80000–90000), below context menus/modals.
      '.pnq-wc-taskbar{position:fixed;left:12px;bottom:12px;z-index:90500;display:flex;' +
      'flex-direction:column-reverse;gap:6px;pointer-events:none;}' +
       '.pnq-wc-taskbar{--pnq-panel-bg:#fff;--pnq-panel-fg:#24292f;--pnq-panel-border:#d0d7de;' +
       '--pnq-head-bg:#f5f5f5;--pnq-hover-bg:#eaeef2;--pnq-fg-dim:#57606a;}' +
       'body.pnq-dark .pnq-wc-taskbar{--pnq-panel-bg:#21262d;--pnq-panel-fg:#c9d1d9;' +
       '--pnq-panel-border:#444c56;--pnq-head-bg:#1c2128;--pnq-hover-bg:#30363d;--pnq-fg-dim:#8b949e;}' +
       '.pnq-wc-taskbar .pnq-wc-task{pointer-events:auto;display:flex;align-items:center;gap:8px;' +
       'max-width:260px;height:34px;padding:0 12px;color:var(--pnq-panel-fg);cursor:pointer;' +
       'background:var(--pnq-panel-bg);-webkit-backdrop-filter:blur(18px) saturate(180%);' +
       'backdrop-filter:blur(18px) saturate(180%);border:1px solid var(--pnq-accent,#3c708a);' +
       'border-radius:6px;box-shadow:0 6px 22px rgba(0,0,0,.5);font:13px/1 system-ui,sans-serif;}' +
       '.pnq-wc-taskbar .pnq-wc-task:hover{background:var(--pnq-hover-bg);}' +
      '.pnq-wc-task .pnq-wc-task-ic{flex:0 0 auto;opacity:.85;}' +
      '.pnq-wc-task .pnq-wc-task-lbl{flex:1 1 auto;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}' +
      // See-through (Item 4): a telnet/serial pane requested transparency; drop the
      // window + iframe backgrounds so the canvas shows through. Titlebar keeps its
      // own glass background (stays usable to toggle back).
       '.' + WIN_CLASS + '.pnq-wc-ghost{background:color-mix(in srgb,var(--pnq-panel-bg) 50%,transparent);box-shadow:none;}' +
       '.' + WIN_CLASS + '.pnq-wc-ghost iframe{background:transparent;}';
    document.head.appendChild(s);
    ensureThemeSync();
  }

  // Legacy windows are appended under <body>, outside the island that owns the
  // --pnq-* variable layer. Read the already-computed island values and mirror
  // them onto these legacy roots; do not redefine the island theme layer.
  function syncThemeVars() {
    var canvas = document.querySelector('.pnq-canvas-flow');
    if (!canvas) return;
    var cs = window.getComputedStyle(canvas);
    var targets = document.querySelectorAll('.' + WIN_CLASS + ',#pnq-wc-taskbar');
    for (var i = 0; i < targets.length; i++) {
      for (var j = 0; j < THEME_VARS.length; j++) {
        var value = cs.getPropertyValue(THEME_VARS[j]).trim();
        if (value) targets[i].style.setProperty(THEME_VARS[j], value);
      }
    }
  }
  function ensureThemeSync() {
    var canvas = document.querySelector('.pnq-canvas-flow');
    if (!canvas) return;
    syncThemeVars();
    if (themeObserver) return;
    themeObserver = new MutationObserver(syncThemeVars);
    themeObserver.observe(canvas, { attributes: true, attributeFilter: ['class'] });
  }

  function raise(win) { zTop = Math.min(zTop + 1, WIN_CEILING); win.style.zIndex = zTop; }

  /* ── minimize to a bottom taskbar (guacamole-style; newest stacks upward) ──── */
  // Console windows AND the aggregated Captures/Wireshark window all use this same
  // chrome, so each minimizes to its own labelled button at the bottom.
  function taskbarEl() {
    var t = document.getElementById('pnq-wc-taskbar');
    if (!t) { t = el('div', 'pnq-wc-taskbar'); t.id = 'pnq-wc-taskbar'; document.body.appendChild(t); }
    return t;
  }
  function titleOf(win) {
    var t = win.querySelector('.pnq-wc-title');
    return (t && t.textContent) ? t.textContent : 'Web Console';
  }
  function minimizeWin(win) {
    if (win.dataset.pnqMin === '1') return;
    // stash geometry before hiding (display:none zeroes offsetWidth) so a refresh
    // restore can bring the window back at its real size/position.
    win._pnqGeo = { left: win.style.left, top: win.style.top,
                    width: win.offsetWidth + 'px', height: win.offsetHeight + 'px', ml: win.style.marginLeft };
    win.dataset.pnqMin = '1';
    win.style.display = 'none';
    var b = el('div', 'pnq-wc-task');
    b.innerHTML = '<span class="pnq-wc-task-ic">&#x25A1;</span><span class="pnq-wc-task-lbl"></span>';
    b.querySelector('.pnq-wc-task-lbl').textContent = titleOf(win);
    b.title = 'Restore — ' + titleOf(win);
    b.addEventListener('click', function () { restoreWin(win); });
    win._pnqTask = b;
    taskbarEl().appendChild(b);
  }
  function restoreWin(win) {
    win.dataset.pnqMin = '';
    win.style.display = '';
    dropTask(win);
    raise(win);
  }
  function dropTask(win) {
    if (win._pnqTask) { win._pnqTask.remove(); win._pnqTask = null; }
  }

  // Lowest allowed window top: the lab's fixed top menu floats ABOVE these
  // windows, so a title bar at top<topbarHeight is covered and can never be
  // grabbed again. Measure the live topbar; fall back to 44px.
  function minTop() {
    var tb = document.querySelector('.navbar, #topbar, .top_bar, #main_nav');
    if (tb) {
      var r = tb.getBoundingClientRect();
      if (r.top <= 1 && r.height > 0 && r.height < 90) return r.bottom;
    }
    return 44;
  }
  // Pull a window back into reach if its title bar ended up under the topbar
  // or off-screen (old saved geometry, historic resize bug).
  function rescueIntoView(win) {
    var t = parseFloat(win.style.top);
    var mt = minTop();
    if (!isNaN(t) && t < mt) win.style.top = mt + 'px';
    var l = parseFloat(win.style.left);
    if (!isNaN(l) && l > window.innerWidth - 60) win.style.left = (window.innerWidth - 60) + 'px';
  }

  function makeDraggable(win, handle, frame) {
    var sx = 0, sy = 0, ox = 0, oy = 0;
    function onMove(e) {
      var nx = Math.max(0, Math.min(window.innerWidth - 60, ox + (e.clientX - sx)));
      var ny = Math.max(minTop(), Math.min(window.innerHeight - 40, oy + (e.clientY - sy)));
      win.style.left = nx + 'px'; win.style.top = ny + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      if (frame) frame.style.pointerEvents = '';        // restore iframe interactivity
    }
    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;                        // left button only
      if (e.target.closest('.pnq-wc-btn')) return;       // not when hitting a button
      var r = win.getBoundingClientRect();
      win.style.left = r.left + 'px'; win.style.top = r.top + 'px'; win.style.marginLeft = '0';
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      // Disable iframe hit-testing during the drag so the iframe can't swallow
      // mousemove/mouseup (a missed mouseup would leave the window stuck to the cursor).
      if (frame) frame.style.pointerEvents = 'none';
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      raise(win); e.preventDefault();
    });
  }

  // Attach 8-direction resize handles to a floating window. Each handle is a small
  // transparent div that lives OUTSIDE the overflow:hidden container (via absolute
  // positioning on the window itself — not inside it). During a drag the iframe
  // gets pointer-events:none so it can't swallow events.
  function makeResizable(win, frame) {
    var dirs = [
      ['n',  'pnq-rh pnq-rh-n',  {top:true,  left:false, right:false, bottom:false}],
      ['s',  'pnq-rh pnq-rh-s',  {top:false, left:false, right:false, bottom:true }],
      ['w',  'pnq-rh pnq-rh-w',  {top:false, left:true,  right:false, bottom:false}],
      ['e',  'pnq-rh pnq-rh-e',  {top:false, left:false, right:true,  bottom:false}],
      ['nw', 'pnq-rh pnq-rh-nw', {top:true,  left:true,  right:false, bottom:false}],
      ['ne', 'pnq-rh pnq-rh-ne', {top:true,  left:false, right:true,  bottom:false}],
      ['sw', 'pnq-rh pnq-rh-sw', {top:false, left:true,  right:false, bottom:true }],
      ['se', 'pnq-rh pnq-rh-se', {top:false, left:false, right:true,  bottom:true }],
    ];
    var MIN_W = 380, MIN_H = 220;
    dirs.forEach(function (d) {
      var handle = document.createElement('div');
      handle.className = d[1];
      var edges = d[2];
      handle.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        var r = win.getBoundingClientRect();
        var startX = e.clientX, startY = e.clientY;
        var startL = r.left, startT = r.top, startW = r.width, startH = r.height;
        if (frame) frame.style.pointerEvents = 'none';
        raise(win);
        function onMove(ev) {
          var dx = ev.clientX - startX, dy = ev.clientY - startY;
          var nw = startW, nh = startH, nl = startL, nt = startT;
          if (edges.right)  nw = Math.max(MIN_W, startW + dx);
          if (edges.bottom) nh = Math.max(MIN_H, startH + dy);
          if (edges.left)  { nw = Math.max(MIN_W, startW - dx); nl = startL + startW - nw; }
          if (edges.top)   { nh = Math.max(MIN_H, startH - dy); nt = startT + startH - nh; }
          // north resize must not push the title bar under the topbar/off-screen
          var mt = minTop();
          if (edges.top && nt < mt) { nh -= (mt - nt); nt = mt; }
          win.style.width  = nw + 'px'; win.style.height = nh + 'px';
          win.style.left   = nl + 'px'; win.style.top    = nt + 'px';
          win.style.marginLeft = '0';
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('mouseup',   onUp,   true);
          if (frame) frame.style.pointerEvents = '';
        }
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup',   onUp,   true);
      });
      win.appendChild(handle);
    });
  }

  // Generic in-lab window for an arbitrary console URL. onPop (optional) opens
  // the same URL in a new tab from the ↗ button. popInNodeId (optional) adds a
  // ⇲ "pop in" button that docks this per-node window back into the main window.
  function openEmbeddedUrl(id, url, titleText, onPop, popInNodeId, size) {
    injectStyle();
    var existing = document.getElementById(id);
    if (existing) {                                        // already open: restore if minimized, else raise
      if (existing.dataset.pnqMin === '1') restoreWin(existing); else raise(existing);
      return existing;
    }

    var win = el('div', WIN_CLASS); win.id = id;
    // Cascade each new window so they don't stack exactly (easy to tile side by side).
    var n = document.querySelectorAll('.' + WIN_CLASS).length;
    if (n > 0) { win.style.left = (40 + n * 32) + 'px'; win.style.top = (70 + n * 30) + 'px'; win.style.marginLeft = '0'; }
    if (size) {                                           // caller-requested default size (e.g. captures: bigger)
      if (size.width)  { win.style.width = size.width; if (n === 0) win.style.marginLeft = '-' + (parseInt(size.width, 10) / 2) + 'px'; }
      if (size.height) win.style.height = size.height;
    }

    var bar = el('div', 'pnq-wc-bar');
    var title = el('div', 'pnq-wc-title', titleText);
    var min = el('div', 'pnq-wc-btn pnq-wc-min', '&#x2013;');   // – minimize to the taskbar
    min.title = 'Minimize';
    min.addEventListener('click', function () { minimizeWin(win); });
    var pop = el('div', 'pnq-wc-btn pnq-wc-pop', '&#x2197;');   // ↗ one-off open in new tab
    pop.title = 'Open in a new tab';
    pop.addEventListener('click', function () { if (onPop) onPop(); dropTask(win); win.remove(); });
    var close = el('div', 'pnq-wc-btn pnq-wc-close', '&times;');
    close.title = 'Close';
    close.addEventListener('click', function () { dropTask(win); win.remove(); });   // destroys iframe -> disconnects
    bar.append(title, min);
    if (popInNodeId != null && popInNodeId !== '') {
      var pin = el('div', 'pnq-wc-btn pnq-wc-pin', '&#x21F2;');   // ⇲ dock back into main
      pin.title = 'Pop in (dock back into the combined window)';
      pin.addEventListener('click', function () { popInNode(popInNodeId); });
      bar.append(pin);
    }
    bar.append(pop, close);

    var frame = document.createElement('iframe');
    frame.src = url;
    frame.setAttribute('title', 'PNetLab web console');

    win.append(bar, frame);
    // raise on any click; also rescue a window whose title bar got stuck
    // under the topbar (old saved geometry / pre-fix resize) — clicking
    // anywhere on it brings it back into reach.
    win.addEventListener('mousedown', function () { raise(win); rescueIntoView(win); });
    document.body.appendChild(win);
    makeDraggable(win, bar, frame);
    makeResizable(win, frame);
    raise(win);
    return win;
  }

  function openEmbedded(nodeId) {
    var perNode = (nodeId != null && nodeId !== '');
    return openEmbeddedUrl(
      winIdFor(nodeId),
      consoleUrl(nodeId),
      nodeId ? ('Console — node ' + nodeId) : 'Web Console (beta)',
      function () { openInTab(nodeId); },
      perNode ? nodeId : null);
  }

  // Pop a per-node window back IN as a tab in the combined main window. The node
  // name/lane are stashed on the per-node window by the 'title' message below.
  function popInNode(nodeId) {
    var pn = document.getElementById('pnq-wc-win-n' + nodeId);
    var name = (pn && pn._pnqNodeName) || ('node ' + nodeId);
    var type = (pn && pn._pnqNodeType) || 'telnet';
    var main = document.getElementById('pnq-webconsole-win');
    function post() {
      var f = main && main.querySelector('iframe');
      if (f && f.contentWindow)
        f.contentWindow.postMessage({ pnq: 'opentab', node: nodeId, name: name, type: type }, location.origin);
    }
    if (!main) {                                        // no combined window yet — create it
      main = openEmbedded(null);
      var fr = main.querySelector('iframe');
      if (fr) fr.addEventListener('load', post); else post();
    } else {
      if (main.dataset.pnqMin === '1') restoreWin(main); else raise(main);
      post();
    }
    if (pn) { dropTask(pn); pn.remove(); }              // close the per-node window
  }

  // Find the floating window that owns the iframe a message came from.
  function winFromSource(src) {
    var frames = document.querySelectorAll('.' + WIN_CLASS + ' iframe');
    for (var i = 0; i < frames.length; i++)
      if (frames[i].contentWindow === src) return frames[i].closest('.' + WIN_CLASS);
    return null;
  }

  /* iframe → parent messages: per-node window title/lane stash + pop-out request */
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin) return;
    var d = e.data;
    if (!d) return;
    if (d.pnq === 'seethru') {                           // telnet/serial see-through toggle
      var sw = winFromSource(e.source);
      if (sw) sw.classList.toggle('pnq-wc-ghost', !!d.on);
      return;
    }
    if (d.pnq === 'tabs') {                              // combined window reported its open tabs
      var tw = winFromSource(e.source);
      if (tw) tw._pnqTabs = Array.isArray(d.nodes) ? d.nodes : [];
      return;
    }
    if (d.pnq === 'popout' && d.node != null) {         // a tab asked to become its own window
      var pw = openEmbedded(d.node);
      if (pw) { if (d.name) pw._pnqNodeName = d.name; if (d.type) pw._pnqNodeType = d.type; }
      return;
    }
    if (d.pnq !== 'title' || d.node == null) return;
    var w = document.getElementById('pnq-wc-win-n' + d.node);
    if (!w) return;
    if (d.name) w._pnqNodeName = d.name;               // remembered for "pop in"
    if (d.type) w._pnqNodeType = d.type;
    var txt = d.name ? ('Console — ' + d.name) : ('Console — node ' + d.node);
    var t = w.querySelector('.pnq-wc-title');
    if (t) t.textContent = txt;
    if (w._pnqTask) {                                   // keep the taskbar label in sync
      var lbl = w._pnqTask.querySelector('.pnq-wc-task-lbl');
      if (lbl) lbl.textContent = txt;
      w._pnqTask.title = 'Restore — ' + txt;
    }
  });

  /* ── public entry points ───────────────────────────────────────────────────── */
  // mode-respecting (Quick Bar + Slice-4 per-node launch)
  function openWebConsole(nodeId) {
    if (getMode() === 'tab') openInTab(nodeId);
    else openEmbedded(nodeId);
  }
  // always an in-lab window (the node-list "↗ own window" / side-by-side action)
  function detachWebConsole(nodeId) { openEmbedded(nodeId); }

  // "Console All": the combined web console — console.html?all=1 auto-opens every
  // console-capable node as a tab in the single main window.
  function consoleAllUrl() { return CONSOLE_URL + '?all=1'; }
  function openWebConsoleAll() {
    if (getMode() === 'tab') { openTabUrl('pnet-wc-main', consoleAllUrl()); return; }
    openEmbeddedUrl('pnq-webconsole-win', consoleAllUrl(), 'Web Console — all nodes',
      function () { openTabUrl('pnet-wc-main', consoleAllUrl()); });
  }

  // mode-respecting opener for an ARBITRARY console URL (used by the packet-capture
  // hook to open console.html?capture=... — keyed/titled by the caller).
  function openConsoleWindow(url, key, title, size) {
    if (getMode() === 'tab') openTabUrl(key, url);
    else openEmbeddedUrl('pnq-wc-win-' + key, url, title || 'Web Console',
      function () { openTabUrl(key, url); }, null, size);
  }

  /* ── sidebar launch-mode toggle ────────────────────────────────────────────── */
  function applyToggleIcon() {
    var ic = document.querySelector('#pnq-wc-mode-toggle i');
    if (ic) ic.className = getMode() === 'tab' ? 'fa fa-toggle-on' : 'fa fa-toggle-off';
  }
  function toggleMode(e) { if (e) e.preventDefault(); setMode(getMode() === 'tab' ? 'embed' : 'tab'); }

  function injectToggle() {
    if (document.getElementById('pnq-wc-mode-toggle')) { injectHtml5Toggle(); return true; }
    var ul = document.querySelector('#lab-sidebar ul');
    if (!ul) return false;
    var li = el('li');
    li.id = 'pnq-wc-mode-toggle';
    li.innerHTML = '<a href="#" title="Open the Web Console in a new browser tab instead of an in-lab window">' +
      '<i class="fa ' + (getMode() === 'tab' ? 'fa-toggle-on' : 'fa-toggle-off') + '" style="font-size:16px;"></i>' +
      '<span class="lab-sidebar-title">Web Console Tab</span></a>';
    li.querySelector('a').addEventListener('click', toggleMode);
    var anchor = document.getElementById('pnq-sysmon-toggle')
      || document.getElementById('pnq-quickbar-toggle')
      || document.getElementById('action_change_console');
    if (anchor && anchor.parentNode === ul) ul.insertBefore(li, anchor.nextSibling);
    else ul.appendChild(li);
    injectHtml5Toggle();
    return true;
  }

  /* ── HTML5 Console sidebar toggle ──────────────────────────────────────────────
   * canvas-flow amputation (b2 Wave 3): the store React lab.js used to render an
   * "HTML Console" switch into the empty <li id="action_change_console">; with
   * lab.js gone that li was left blank (a prior fix set it display:none). This
   * rebuilds the toggle in the sidebar next to "Web Console Tab":
   *   • html5 ON  = double-click opens the in-browser web console (guacamole);
   *   • html5 OFF = double-click hands off to the native telnet/ssh/vnc handler.
   * Clicking flips window.HTML5 (+ window.server.user.html5 when present) so
   * html5Mode() reflects it IMMEDIATELY for the next dblclick. Persistence is
   * best-effort client-side (localStorage + cookie): the engine has no clean
   * per-user "set my own html5" REST lane (the flag is only editable via the
   * admin user editor / chosen at the offline-login Console dropdown), so a page
   * reload re-reads the server value from /api/auth — we re-assert our stored
   * preference over it on load so the toggle survives a refresh in practice. */
  var HTML5_KEY = 'pnq_html5_console';
  function storedHtml5() {
    try {
      var v = localStorage.getItem(HTML5_KEY);
      if (v === '0' || v === '1') return v;
    } catch (e) {}
    var m = ('; ' + document.cookie).split('; ' + HTML5_KEY + '=');
    if (m.length === 2) { var c = m.pop().split(';').shift(); if (c === '0' || c === '1') return c; }
    return null;
  }
  function persistHtml5(on) {
    var v = on ? '1' : '0';
    try { localStorage.setItem(HTML5_KEY, v); } catch (e) {}
    try { document.cookie = HTML5_KEY + '=' + v + ';path=/;max-age=' + (60 * 60 * 24 * 365) + ';SameSite=Lax'; } catch (e) {}
  }
  function applyHtml5Icon() {
    var ic = document.querySelector('#pnq-html5-toggle i');
    if (ic) ic.className = 'fa ' + (html5Mode() ? 'fa-toggle-on' : 'fa-toggle-off');
  }
  // Reseed the topology after the server-side html5 flag flips so every node's
  // url is rebuilt (web-console vs native telnet://) by the SAME lane the
  // island's write path already uses after a structural change: the app-
  // topology stub's fireReseed() dispatches this event on `document`, and the
  // canvas-flow island listens for it and calls reseedFromApi() (see
  // pnetlab-app-topology-stub.js fireReseed / CanvasFlow.svelte's
  // 'pnq:app-updatedata' listener). Reusing that channel means we don't invent
  // a second reseed path.
  function reseedTopology() {
    try { document.dispatchEvent(new CustomEvent('pnq:app-updatedata', { detail: { update: 'html5' } })); } catch (e) {}
  }
  function setHtml5(on) {
    window.HTML5 = on ? 1 : 0;
    try { if (window.server && window.server.user) window.server.user.html5 = on ? '1' : '0'; } catch (e) {}
    persistHtml5(on);
    applyHtml5Icon();
    // Persist to users.html5 server-side so api.php rebuilds every node.url as
    // the native telnet:// URL (html5=0) or the web-console URL (html5=1), then
    // reseed the topology so the live node map picks up the new URLs.
    try {
      fetch('/users/api.php?action=set_html5', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ html5: on ? 1 : 0 })
      }).then(function () { reseedTopology(); }).catch(function () {});
    } catch (e) {}
  }
  function toggleHtml5(e) { if (e) e.preventDefault(); setHtml5(!html5Mode()); }
  function injectHtml5Toggle() {
    if (document.getElementById('pnq-html5-toggle')) return;
    var ul = document.querySelector('#lab-sidebar ul');
    if (!ul) return;
    var li = el('li');
    li.id = 'pnq-html5-toggle';
    li.innerHTML = '<a href="#" title="HTML5 Console: ON opens the in-browser web console; OFF uses the native telnet/ssh/vnc handler">' +
      '<i class="fa ' + (html5Mode() ? 'fa-toggle-on' : 'fa-toggle-off') + '" style="font-size:16px;"></i>' +
      '<span class="lab-sidebar-title">HTML5 Console</span></a>';
    li.querySelector('a').addEventListener('click', toggleHtml5);
    var anchor = document.getElementById('pnq-wc-mode-toggle');
    if (anchor && anchor.parentNode === ul) ul.insertBefore(li, anchor.nextSibling);
    else ul.appendChild(li);
  }
  // On load, re-assert a previously-stored preference over the server-derived value
  // (/api/auth sets window.HTML5 from the users table; our client toggle can't write
  // that column, so this keeps the toggle sticky across reloads — best-effort).
  (function reassertStoredHtml5() {
    var s = storedHtml5();
    if (s === null) return;
    try {
      window.HTML5 = (s === '1') ? 1 : 0;
      if (window.server && window.server.user) window.server.user.html5 = s;
    } catch (e) {}
  })();

  /* ── session restore: reopen console windows after a page refresh ──────────── */
  // A hard refresh wipes the DOM (and the live sockets), so true socket survival
  // isn't possible. Instead we snapshot the open windows on unload and recreate
  // them on load — each iframe reloads console.html and RECONNECTS (telnet
  // re-attaches to the live device line; rdp/vnc re-attach to the desktop). Local
  // scrollback is the only thing lost. sessionStorage scopes it to this tab.
  function saveOpenConsoles() {
    try {
      var key = stateKey();
      if (!key) return;
      var out = [], wins = document.querySelectorAll('.' + WIN_CLASS);
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i], iframe = w.querySelector('iframe');
        if (!iframe) continue;
        var min = w.dataset.pnqMin === '1';
        var url = iframe.src;
        // the combined window restores its EXACT tabs (reported by the iframe).
        if (w.id === 'pnq-webconsole-win' && w._pnqTabs && w._pnqTabs.length)
          url = CONSOLE_URL + '?nodes=' + w._pnqTabs.map(encodeURIComponent).join(',');
        var ent = { id: w.id, url: url, title: titleOf(w), min: min,
                    ghost: w.classList.contains('pnq-wc-ghost'),
                    nodeName: w._pnqNodeName || '', nodeType: w._pnqNodeType || '' };
        if (!min) {                                      // capture the real on-screen rect
          var r = w.getBoundingClientRect();
          ent.left = r.left + 'px'; ent.top = r.top + 'px';
          ent.width = w.offsetWidth + 'px'; ent.height = w.offsetHeight + 'px'; ent.ml = '0';
        } else if (w._pnqGeo) {
          ent.left = w._pnqGeo.left; ent.top = w._pnqGeo.top;
          ent.width = w._pnqGeo.width; ent.height = w._pnqGeo.height; ent.ml = w._pnqGeo.ml;
        }
        out.push(ent);
      }
      // Prune BEFORE writing, not after: if stale other-lab entries already
      // exhausted the quota, a write-then-prune order throws out of setItem
      // and the catch below swallows it before prune ever runs — freeing
      // nothing, wedging every future save behind the same stale entries.
      pruneOtherLabState(key);
      sessionStorage.setItem(key, JSON.stringify(out));
    } catch (e) {}
  }
  function restoreOpenConsoles() {
    var key = stateKey();
    if (!key) return;
    var raw;
    try { raw = sessionStorage.getItem(key); } catch (e) { return; }
    if (!raw) return;
    var list; try { list = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(list) || !list.length) return;
    list.forEach(function (ent) {
      var m = /^pnq-wc-win-n(.+)$/.exec(ent.id);
      var popInId = m ? m[1] : null;
      var url = ent.url;
      var win = openEmbeddedUrl(ent.id, url, ent.title || 'Web Console',
        function () { openTabUrl(ent.id, url); }, popInId);
      if (!win) return;
      if (ent.nodeName) win._pnqNodeName = ent.nodeName;
      if (ent.nodeType) win._pnqNodeType = ent.nodeType;
      if (ent.left) { win.style.left = ent.left; win.style.top = ent.top; win.style.marginLeft = ent.ml || '0'; rescueIntoView(win); }
      if (ent.width) { win.style.width = ent.width; win.style.height = ent.height; }
      if (ent.ghost) win.classList.add('pnq-wc-ghost');
      if (ent.min) minimizeWin(win);
    });
  }
  window.addEventListener('beforeunload', saveOpenConsoles);
  window.addEventListener('pagehide', saveOpenConsoles);

  function reassertStoredHtml5Late() {
    var s = storedHtml5();
    if (s === null) return;
    try {
      window.HTML5 = (s === '1') ? 1 : 0;
      if (window.server && window.server.user) window.server.user.html5 = s;
    } catch (e) {}
    applyHtml5Icon();
  }
  function init() {
    if (!injectToggle()) {
      var mo = new MutationObserver(function () { if (injectToggle()) mo.disconnect(); });
      mo.observe(document.body, { childList: true, subtree: true });
    }
    // /api/auth sets window.HTML5 from the server AFTER load; re-assert our stored
    // preference over it (and resync the toggle icon) a couple times as it lands.
    [300, 1200, 3000].forEach(function (ms) { setTimeout(reassertStoredHtml5Late, ms); });
    // Wait for BOTH the "let the lab view settle" delay AND the lab-id fetch
    // (capped at 3s so a hung request can't block restore forever) before
    // calling restoreOpenConsoles — sampling _labId at a bare 600ms timeout
    // would silently skip restoring on a slow load, and the next unload's
    // saveOpenConsoles() would then overwrite the still-good saved state with
    // an empty one, quietly losing it (see the comment above stateKey()).
    var settle = new Promise(function (res) { setTimeout(res, 600); });
    var labIdReady = Promise.race([_labIdPromise, new Promise(function (res) { setTimeout(res, 3000); })]);
    Promise.all([settle, labIdReady]).then(restoreOpenConsoles);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* ── keep right-click modals + menus ABOVE the console window ──────────────── */
  // The stock engine opens overlays BELOW the console band (80000–90000). Rather
  // than edit the minified engine, watch the DOM and lift them. raise() is capped
  // at WIN_CEILING so a console window can never out-climb them.
  var MENU_Z = 91000;          // canvas right-click menu (above windows + taskbar)

  // A modal is "shown" once Bootstrap has flipped it visible (class 'in' or an
  // inline display:block).
  function isModalShown(m) {
    return m.classList.contains('in') || (m.style && m.style.display === 'block');
  }
  // Lift EVERY currently-shown modal above the backdrop. Stock modals come in two
  // shapes: ones the engine inserts fresh on open (add-node/edit/error — caught as
  // added nodes below) AND ones that PRE-EXIST in the DOM and are merely toggled
  // visible by Bootstrap — e.g. the React "System Status" modal (lab.js, inline
  // z-index:1048). The latter is never an added node, so on its own its freshly
  // inserted backdrop (raised to 99999) would trap it underneath and leave the
  // canvas covered/unclickable. Every .modal('show') inserts one .modal-backdrop,
  // so we re-sweep shown modals whenever a backdrop appears (now, and after
  // Bootstrap's display/fade reflow lands).
  function raiseShownModals() {
    var mods = document.querySelectorAll('.modal');
    for (var i = 0; i < mods.length; i++) if (isModalShown(mods[i])) mods[i].style.zIndex = (++zModal);
  }
  // Re-home shown modals to <body> — the same parent the WORKING lab modals use.
  // The engine's addModal() (Add Line / Custom Shape / Text / Startup Configs)
  // appends to <body>, so those sit above everything and stay clickable. But the
  // React lab portals Add Node / System Status into the low-z app frame
  // `.bottom_frame` (z~1041, which also holds the canvas + the lab sidebar). A
  // modal there is capped by that frame's stacking context: it can't climb past
  // the raised backdrop OR the sidebar, so it renders greyed-out and UNCLICKABLE.
  // Moving it to <body> makes it a top-level modal like the working ones, where
  // the z-index floor below lifts it above the 99999 backdrop. (Idempotent; the
  // re-append fires another mutation the observer ignores since it's already body.)
  function reparentShownModals() {
    var mods = document.querySelectorAll('.modal');
    for (var i = 0; i < mods.length; i++) {
      var m = mods[i];
      if (isModalShown(m) && m.parentElement && m.parentElement !== document.body) {
        document.body.appendChild(m);
      }
    }
  }
  function sweep() { reparentShownModals(); raiseShownModals(); }
  function bumpModal(n) {
    if (!n || n.nodeType !== 1 || !n.classList) return;
    if (n.classList.contains('modal-backdrop')) {
      n.style.zIndex = MODAL_BACKDROP_Z;
      sweep();                  // freshly-inserted modals are already shown
      setTimeout(sweep, 0);     // pre-existing modals: after display/in flips
      setTimeout(sweep, 60);    // after the synchronous reflow
      setTimeout(sweep, 220);   // after Bootstrap's backdrop fade settles
    } else if (n.classList.contains('modal')) {
      n.style.zIndex = (++zModal);
      if (isModalShown(n) && n.parentElement && n.parentElement !== document.body) document.body.appendChild(n);
    }
  }
  // The canvas right-click menu (#context-menu, printContextMenu) is a plain
  // body-level dropdown with no backdrop — not a .modal — so it isn't caught
  // above; lift it so "Add a new object" / node menus open in front of, not
  // behind, an open console window.
  function bumpMenu(n) {
    if (n && n.nodeType === 1 && n.id === 'context-menu') n.style.zIndex = MENU_Z;
  }
  var modalObserver = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        bumpModal(n); bumpMenu(n);
        if (n.querySelectorAll) {
          var inner = n.querySelectorAll('.modal, .modal-backdrop, #context-menu');
          for (var k = 0; k < inner.length; k++) { bumpModal(inner[k]); bumpMenu(inner[k]); }
        }
      }
    }
  });
  modalObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });

  // ── modal floor: keep EVERY modal above the raised backdrop ─────────────────
  // This file raises .modal-backdrop to MODAL_BACKDROP_Z (99999) so right-click
  // modals clear the console window. That left lab modals UNDER the backdrop —
  // greyed-out + unclickable — in two ways, both fixed here with a CSS floor:
  //   * click-through modals: the React bundle pins `.modal.click{z-index:1047
  //     !important}` / `.modal.click.active{z-index:1048!important}` (pre-99999
  //     values) which, via !important, override the inline z-index the observer
  //     sets. (Startup Configs is one of these.)
  //   * plain modals: the React bundle renders others as `.modal fade` with an
  //     INLINE z-index:1048; when a re-render resets that inline value the
  //     observer's raise is lost. (System Status / the React Add-Node form.)
  // A blanket `.modal` floor above 99999 covers BOTH (it beats an inline z-index
  // because it's !important, and beats the bundle's !important rules because the
  // `body:has(#pnetlab-quickbar)` prefix adds an id's worth of specificity). The
  // .click / .click.active rules keep their relative order one notch higher.
  // Injected on load (not on console-open) so it applies before the console is
  // first used. z-index only — the click-through pointer-events behaviour is left
  // untouched; harmless on hidden modals (no box, no stacking).
  (function injectModalFloor() {
    var ID = 'pnq-modal-floor';
    if (document.getElementById(ID)) return;
    var s = document.createElement('style');
    s.id = ID;
    s.textContent =
      'body:has(#pnetlab-quickbar) .modal{z-index:100039!important;}' +
      'body:has(#pnetlab-quickbar) .modal.click{z-index:100040!important;}' +
      'body:has(#pnetlab-quickbar) .modal.click.active{z-index:100041!important;}' +
      // Toast alerts (incl. error_handle's danger toasts) must render above the
      // island overlay portal (#pnq-overlay-portal, PORTAL_Z 100100 — see
      // work/islands/.../ui/overlay-portal.js) so a Save/API failure raised while
      // an island dialog (NodeEdit, NetworkAdd, …) is open is not hidden under
      // that dialog's full-viewport backdrop. 100200 clears the portal (100100),
      // the legacy modal floor (100039-41) AND the console band (windows 80000-
      // 90000 + 90500 taskbar) — error feedback is the one layer that must always
      // be on top. (Was 100050, which sat below the portal and greyed toasts out.)
      '#alert_container,#notification_container{position:fixed;z-index:100200!important;}';
    (document.head || document.documentElement).appendChild(s);
  })();

  // Quick Bar button (#pnetlab-quickbar .pnq-webconsole, added in index.html).
  document.addEventListener('click', function (e) {
    var t = e.target;
    var btn = t && t.closest ? t.closest('.pnq-webconsole') : null;
    if (!btn) return;
    if (!html5Mode()) return;                            // HTML5 Console disabled — do nothing
    e.preventDefault();
    e.stopPropagation();
    openWebConsole();
  });

  /* ── route node-console clicks to the web console (no native EVE terminal) ──── */
  // EVE's lab.js opens a node console by delegating a BUBBLE-phase jQuery click on
  // `.nodehtmlconsole` to its OWN tabbed "Terminal" window (orange `.html_tab`),
  // which then embeds /console/console.html in an iframe → a DUPLICATE tab heading
  // (native orange tab + our inner tab). With the Slice-5 cutover the web console
  // IS the console, so intercept that click in the CAPTURE phase and open our own
  // floating window instead, stopping propagation so EVE's handler never runs.
  // Only in HTML5 (in-browser) mode — the native telnet:// path (html5=0) is left
  // untouched. (The old jsPlumb-era App.topology.isClick drag guard is gone — b2
  // Wave 3 amputation: lab.js no longer drags these frames; the flow island owns
  // dragging, and the stub's isClick is permanently true.)
  // Primary console only (`.nodehtmlconsole`); the rarely-used 2nd console
  // (`.nodehtmlconsole2nd`) keeps EVE's handler.
  function html5Mode() {
    try {
      if (typeof window.HTML5 !== 'undefined') return String(window.HTML5) === '1';
      if (window.server && window.server.user) return String(window.server.user.html5) === '1';
    } catch (e) {}
    return false;
  }
  // Open a node's NATIVE console (html5=0) — telnet://, ssh://, vnc:// (rdp/http
  // route through the engine). Mirrors EVE's lab.js addTab(): the engine already
  // builds node.url as the protocol URL when the user's html5 flag is 0
  // (device.php getConsoleUrl). We just open it, so double-click behaves the
  // same in BOTH modes (web console in html5, native handler in non-html5).
  function openNativeConsole(nid) {
    var node = null;
    try { node = window.nodes && window.nodes[nid]; } catch (e) { return; }
    if (!node) return;
    if (node.status != 2 && node.status != 3) return;   // only when running
    // Route the primary lane; anything we can't launch natively (a transient
    // /console/console.html url mid-toggle-reseed, unknown type) falls back to
    // the web console rather than a top-nav. winKey is the stable per-node
    // popup-window name dispatchNativeLane uses for the html5-mode http/https
    // managed-window lane (see dispatchNativeLane) — irrelevant to the other
    // native lanes, which ignore it.
    if (!dispatchNativeLane(node.url, node.console, node.name, 'pnqweb-' + nid, nid, 1)) openWebConsole(nid);
  }

  // Build an .rdp file from a native rdp://host:port url and hand it to the
  // browser as a download the local Remote Desktop client (mstsc / MS RD app)
  // opens. This IS the native RDP path: with HTML5 off the engine emits
  // rdp://<host>:<port> (device.php getConsoleUrl — the SAME host:port the
  // telnet/vnc native lanes and guacd use), and we materialise the minimal .rdp
  // descriptor client-side. No server round-trip; CSP-safe (a Blob URL + an
  // <a download> click, no inline/custom-scheme handler). Returns false if the
  // url isn't a real rdp:// (e.g. the transient /console/console.html during the
  // toggle reseed) so the caller falls back to the web console.
  function downloadRdpFile(url, name) {
    try {
      var m = /^rdp:\/\/\[?([^\]\/?#]+?)\]?:(\d+)/i.exec(String(url || ''));
      if (!m) return false;
      var host = m[1], port = m[2];
      var fn = String(name || 'node').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
      var body = [
        'full address:s:' + host + ':' + port,
        'prompt for credentials:i:1',   // ask for the lab creds (e.g. admin/pnet)
        'authentication level:i:0',      // connect even if server auth can't be verified (lab nodes)
        'screen mode id:i:2',            // full screen (2) — 1 forced a fixed small window with no way to expand
        'use multimon:i:0',
        'span monitors:i:0',
        'smart sizing:i:1',
        'redirectclipboard:i:1',
        ''
      ].join('\r\n');
      var blob = new Blob([body], { type: 'application/x-rdp' });
      var href = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = href; a.download = fn + '.rdp'; a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(href); } catch (e) {} }, 1500);
      return true;
    } catch (e) { return false; }
  }

  // Brief non-blocking feedback for a native SCHEME handoff (telnet/ssh/spice/
  // winbox): the browser gives NO signal whether an OS handler exists, so an
  // unregistered scheme is a silent no-op. Confirm we tried + hint at the fix so
  // it's never "nothing happens". Self-contained (no page-toast dependency);
  // CSP-safe (DOM .style + textContent only, no innerHTML/inline-style attrs).
  var _pnqHintTimer = null;
  function showConsoleHint(line1, line2) {
    try {
      var box = document.getElementById('pnq-native-hint');
      if (!box) {
        box = document.createElement('div');
        box.id = 'pnq-native-hint';
        box.setAttribute('role', 'status');
        box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:100000;max-width:360px;' +
          'background:#21262d;color:#c9d1d9;border:1px solid #444c56;border-radius:8px;' +
          'padding:10px 13px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
          'box-shadow:0 6px 20px rgba(0,0,0,.5);opacity:0;transition:opacity .2s ease;pointer-events:none;';
        document.body.appendChild(box);
      }
      box.textContent = '';
      var l1 = document.createElement('div'); l1.textContent = line1; box.appendChild(l1);
      if (line2) { var l2 = document.createElement('div'); l2.textContent = line2; l2.style.cssText = 'color:#8b949e;font-size:12px;margin-top:3px;'; box.appendChild(l2); }
      box.style.opacity = '1';
      clearTimeout(_pnqHintTimer);
      _pnqHintTimer = setTimeout(function () { box.style.opacity = '0'; }, 5500);
    } catch (e) {}
  }
  // Feedback for a native SCHEME handoff (telnet/ssh/…): an unregistered scheme
  // is a silent no-op, so confirm we tried + hint at the fix.
  function nativeHandoffHint(url, name) {
    var proto = (String(url).split(':')[0] || 'native').toLowerCase();
    showConsoleHint('Opening ' + (name ? String(name) : 'console') + ' in your ' + proto.toUpperCase() + ' client…',
      'If nothing opens, register a ' + proto + ':// handler (PNetLab client pack) or switch HTML5 Console on.');
  }
  // Feedback for the RDP FILE handoff: .rdp opens in Remote Desktop (mstsc, built
  // into Windows) — brief confirmation that the download fired.
  function fileHandoffHint(name) {
    showConsoleHint('Downloaded ' + (name ? String(name) : 'console') + '.rdp — opening in Remote Desktop…');
  }

  // Dispatch ONE native console lane by (url, console-type). Shared by the 1st
  // and 2nd console, AND by openHtml5AwareConsole/its 2nd-console counterpart
  // for the native-only types (spice/winbox/http/https — see
  // isNativeOnlyConsole) even when the user's html5 flag is ON, since the web
  // console (console.html) has no bridge for those. Returns true if it
  // launched something, false to let the caller fall back to the web console
  // (transient reseed url / unknown type).
  //   rdp / rdp-tls    → .rdp file download (mstsc is built into Windows, so the
  //                      .rdp opens with zero setup; rdp:// was historically the
  //                      dead /rdp/ path, so a file is the reliable RDP lane)
  //   telnet/ssh/vnc/spice/winbox → OS protocol handler via fireNativeHandler +
  //                      a feedback hint. The PNetLab client integration pack
  //                      registers these schemes (telnet://ssh://vnc://
  //                      spice://winbox://) and opens the native client
  //                      in-browser; the hint just covers the case where no
  //                      handler is registered.
  //   http / https     → the ONLY lane whose window UX splits on html5Mode():
  //                        * html5 ON  — a managed popup window, keyed by a
  //                          STABLE per-node name (winKey) exactly like the
  //                          other HTML5 web consoles' "new tab" mode
  //                          (openTabUrl above: window.open(url, name) then
  //                          .focus()). Re-opening the same node's console
  //                          FOCUSES the existing window instead of spawning
  //                          another tab. Deliberately a real top-level
  //                          window, NOT an iframe: self-signed-cert
  //                          interstitials and X-Frame-Options-protected
  //                          pages only render correctly outside an iframe,
  //                          and console.html has no bridge for http/https
  //                          anyway (isNativeOnlyConsole).
  //                        * html5 OFF (native mode) — plain window.open(url,
  //                          '_blank'), i.e. the original new-tab behaviour,
  //                          unchanged. Users asked for exactly this split:
  //                          app-style managed window when HTML5 Console is
  //                          on, a disposable tab when it's off.
  //                      The browser gives no signal on success, but
  //                      window.open DOES return null/falsy when the popup
  //                      was blocked — surface that via showConsoleHint
  //                      (distinct message from the "opened" case) instead of
  //                      the usual silent no-op. Still true in both cases: we
  //                      handled the type, a web-console fallback would be
  //                      the wrong lane regardless.
  // Only RDP is a FILE; VNC/telnet/ssh/spice/winbox fire their REAL scheme so
  // the client pack's handler opens the native client exactly as before (an
  // earlier attempt to download a .vnc file broke that for client-pack users).
  // A web-console URL matches nothing here → false → web console.
  // winKey (optional): stable per-node popup-window name for the html5-mode
  // http/https lane only (callers pass e.g. 'pnqweb-'+nid); every other lane
  // ignores it.
  // Build the /console/webwait.html loader URL for an http/https console lane.
  // The loader polls the server-side portcheck endpoint (nodeId/which — never
  // the raw target — go to the SERVER, which derives host/port itself) and
  // only navigates to `url` once the node's web GUI is actually listening.
  function webwaitUrl(url, name, nodeId, which) {
    var qs = 'node=' + encodeURIComponent(nodeId || '') +
      '&url=' + encodeURIComponent(url) +
      '&name=' + encodeURIComponent(name || '');
    if (which === 2) qs += '&which=2';
    return '/console/webwait.html?' + qs;
  }

  function dispatchNativeLane(url, ctype, name, winKey, nodeId, which) {
    if (!url) return false;
    ctype = String(ctype || '').toLowerCase();
    if ((ctype === 'rdp' || ctype === 'rdp-tls') && /^rdp:\/\//i.test(url)) {
      if (downloadRdpFile(url, name)) { fileHandoffHint(name); return true; }
      return false;
    }
    if (/^(telnet|ssh|vnc|spice|winbox):/i.test(url)) { fireNativeHandler(url); nativeHandoffHint(url, name); return true; }
    if (ctype === 'http' || ctype === 'https') {
      // Docker nodes with an http/https console start instantly but their
      // in-container web GUI can take 10-15s (firstboot wait + daemon boot)
      // to actually listen — opening `url` straight away used to land the
      // window on a browser connection-refused page. Route through the
      // webwait loader (SAME window semantics as before: same winName /
      // '_blank' target) which polls the portcheck endpoint and only
      // navigates to the real console once it answers.
      var loaderUrl = webwaitUrl(url, name, nodeId, which);
      var w, html5 = html5Mode();
      if (html5) {
        var winName = String(winKey || ('pnqweb-' + (name || 'node'))).replace(/[^\w-]+/g, '_');
        w = window.open(loaderUrl, winName);
        if (w) { try { w.focus(); } catch (e) {} }
      } else {
        w = window.open(loaderUrl, '_blank');
      }
      if (!w) {
        showConsoleHint('Popup blocked — allow popups for this site to open ' + (name ? String(name) : 'console') + '.', url);
      } else {
        showConsoleHint(html5
          ? 'Opening ' + (name ? String(name) : 'console') + ' in a console window…'
          : 'Opening ' + (name ? String(name) : 'console') + ' in a new browser tab…');
      }
      return true;
    }
    return false;
  }

  // Invoke an OS protocol handler (telnet:// etc.) without opening a browser tab
  // and without a custom-protocol iframe (CSP default-src 'self' blocks those).
  // A transient anchor click hands the URL to the registered handler; the current
  // document is not navigated for an external-scheme URL.
  function fireNativeHandler(url) {
    try {
      var a = document.createElement('a');
      a.href = url;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { document.body.removeChild(a); } catch (e) {} }, 0);
    } catch (e) {
      try { window.location.href = url; } catch (e2) {}
    }
  }

  // html5-aware packet capture. html5 ON: the in-browser docker/VNC Wireshark
  // (window.wireshark_capture, capture-console.js) — unchanged. html5 OFF: native
  // local Wireshark — resolve the host tap server-side (capture_native.php ->
  // captureMirrorTap, ownership-checked), build capture://<host>/<tap> and hand it
  // to the OS protocol handler via the SAME anchor shim as the native console
  // (EVE/PNetLab client pack wireshark_wrapper.bat runs tcpdump -i <tap> over SSH).
  function openHtml5AwareCapture(nodeId, ifaceId) {
    if (html5Mode()) {
      if (typeof window.wireshark_capture === 'function') window.wireshark_capture(Number(nodeId), Number(ifaceId));
      return;
    }
    fetch('/console/capture_native.php?node=' + encodeURIComponent(nodeId) + '&iface=' + encodeURIComponent(ifaceId),
          { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.tap) {
          var why = (j && j.why) ? j.why : 'Capture is not available for this interface.';
          try { if (window.App && typeof window.App.toast === 'function') window.App.toast(why, 'error'); else console.warn('[capture]', why); } catch (e) { console.warn('[capture]', why); }
          return;
        }
        fireNativeHandler('capture://' + window.location.hostname + '/' + j.tap);
      })
      .catch(function () {});
  }

  // Console types the built-in web console CANNOT serve, even when html5 is ON:
  // spice/winbox/http/https have no console.html bridge (console-init.js /
  // token_mint.php only carry telnet/vnc/rdp into the xterm/guac frame). For
  // these, device.php's getConsoleUrl/getSecondConsoleUrl already emit a native
  // scheme URL (spice://, winbox://, http://, https://) EVEN in the html5=1
  // branch — so node.url/node.url_2nd is native-ready regardless of the user's
  // html5 flag. telnet/ssh/vnc/rdp stay on the web console when html5 is ON;
  // they only fall back to native when html5 is OFF (openNativeConsole).
  function isNativeOnlyConsole(ctype) {
    ctype = String(ctype || '').toLowerCase();
    return ctype === 'spice' || ctype === 'winbox' || ctype === 'http' || ctype === 'https';
  }

  // html5-aware single entry point: web console when html5 is ON (except the
  // native-only types above, which route natively regardless), native
  // telnet/ssh/vnc handoff when OFF. Used by BOTH the legacy dblclick capture
  // handler below and the island's node dblclick/menu Console action, so there
  // is exactly one place that decides web-vs-native per node.
  // Resolve a node's console metadata (console type + url) before deciding the
  // lane. window.nodes[nid].console/.url are seeded ASYNC by the flow island's
  // topology reseed / app-topology stub. The stub owns the authoritative raw
  // table, field-wise merge, and readiness gate; consume that map here rather
  // than maintaining a second fetch-and-merge path that can drift or clobber it.
  function ensureNodeMeta(nid, cb) {
    var n = null;
    try { n = window.nodes && window.nodes[nid]; } catch (e) {}
    if (n && n.console && n.url) { cb(n); return; }
    var ensureReady = null;
    try { ensureReady = window.__pnqEnsureWindowNodesReady; } catch (e) {}
    if (typeof ensureReady !== 'function') { cb(n); return; }
    var ready = null;
    try { ready = ensureReady(); } catch (e) {}
    function finish() {
      var nn = null;
      try { nn = window.nodes && window.nodes[nid]; } catch (e) {}
      cb(nn);
    }
    if (ready && typeof ready.then === 'function') { ready.then(finish); return; }
    finish();
  }

  // EMBED lane for an http/https docker console (html5 ON + getMode()==='embed').
  // A new server-side authenticated reverse proxy lets the SAME-ORIGIN URL
  // /console/http/<token>/ be embedded in an iframe, so instead of the new-tab
  // webwait window we mint a short-lived token and load the proxy URL into the
  // existing floating in-lab window (openEmbeddedUrl — same drag/resize/minimize/
  // pop-out chrome as every other in-lab console). Additive: the raw new-tab lane
  // (dispatchNativeLane / webwait loader) is untouched and stays reachable from
  // the window's ↗ pop-out button, and is also the mint-failure fallback so the
  // console always opens. CSP-clean: plain fetch + DOM, no eval / string timers.
  //   which — 1 = primary console, 2 = 2nd console (parametric for symmetry;
  //           openHtml5AwareConsole only ever passes 1).
  function openEmbeddedProxyUrl(nid, which) {
    which = (which === 2) ? 2 : 1;
    var node = null;
    try { node = window.nodes && window.nodes[nid]; } catch (e) {}
    var name  = (node && node.name) ? String(node.name) : ('node ' + nid);
    var ctype = node ? String((which === 2 ? node.console_2nd : node.console) || '').toLowerCase() : '';
    var rawUrl = node ? (which === 2 ? node.url_2nd : node.url) : '';
    var winKey = 'pnqweb-' + nid + (which === 2 ? '-2' : '');   // stable per-node id/name
    // ↗ pop-out + mint-failure fallback: the EXISTING raw new-tab lane, exactly
    // as the tab mode / native mode uses it (webwait loader → managed window/tab).
    // dispatchNativeLane shows its own console hint, so we don't double-toast.
    function toTab() {
      dispatchNativeLane(rawUrl, ctype || 'http', name, winKey, nid, which);
    }
    var mintUrl = '/console/token_mint.php?type=http&node=' + encodeURIComponent(nid) +
      (which === 2 ? '&second=1' : '');
    fetch(mintUrl, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('mint ' + r.status);   // 401/404/409 → fallback
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.token) throw new Error('no token');
        var proxyUrl = '/console/http/' + j.token + '/';
        // Load the same-origin proxy URL into the floating iframe window. The ↗
        // pop-out (onPop) opens the raw new-tab lane; no ⇲ pop-in (null).
        openEmbeddedUrl(winKey, proxyUrl, name, toTab, null);
      })
      .catch(function () {
        // Mint failed (401/404/409/network) → keep the console working by opening
        // the existing new-tab lane; dispatchNativeLane surfaces the console hint.
        toTab();
      });
  }

  // FAST PATH for the native lane — restores the instant telnet:// handoff.
  //
  // ensureNodeMeta() below parks on the island's topology reseed (up to
  // READINESS_TIMEOUT_MS), which is correct but made every native console click
  // wait seconds for metadata that needs no server round-trip. The island's OWN
  // store is seeded well before the legacy window.nodes map and carries
  // name/status/port/consoleType/url (api-seed.js nodeRecord), so the handoff can
  // be built synchronously, INSIDE the click gesture.
  //
  // It uses the store's `url` VERBATIM rather than rebuilding <type>://<host>:<port>.
  // Two reasons, both learned by measuring the gate rather than reading source:
  //   * IOL nodes report console:"" while their url is a perfectly good
  //     telnet://host:port — so a scheme derived from consoleType would be empty
  //     for one of the commonest node types and this whole path would sit inert.
  //     (That empty console field is also why the warm path above never fires for
  //     IOL, i.e. why the delay was seen on EVERY click rather than the first.)
  //   * the engine's url carries the authoritative HOST; location.hostname would
  //     only sometimes agree with it.
  //
  // Deliberately narrow. Returns false — falling through to the slow, correct
  // path — unless the store has the node, reports it RUNNING (the same gate
  // openNativeConsole applies; never hand a client a dead port), and the url is
  // one of the scheme lanes dispatchNativeLane routes via fireNativeHandler.
  // http/https are EXCLUDED on purpose: they go through the webwait loader, whose
  // window.open must stay inside the gesture.
  function fastNativeFromStore(nid) {
    var nodes = null;
    try { nodes = window.PNQStore && window.PNQStore.state && window.PNQStore.state.nodes; } catch (e) {}
    var n = nodes && nodes[String(nid)];
    if (!n) return false;
    if (n.status != 2 && n.status != 3) return false;
    var url = String(n.url || '');
    if (!/^(telnet|ssh|vnc|spice|winbox):\/\//i.test(url)) return false;
    var ctype = String(n.consoleType || '').toLowerCase() || url.split(':')[0].toLowerCase();
    return dispatchNativeLane(url, ctype, n.name || ('node ' + nid), 'pnqweb-' + nid, nid, 1);
  }

  function openHtml5AwareConsole(nid) {
    if (!html5Mode()) {
      // Native (html5 OFF) lane. Warm path — metadata already seeded (after the
      // island reseed / a refresh): hand off synchronously, inside the click
      // gesture, exactly as before.
      var nn = null;
      try { nn = window.nodes && window.nodes[nid]; } catch (e) {}
      if (nn && nn.console && nn.url) { openNativeConsole(nid); return; }
      // Store-backed fast path before the wait — see fastNativeFromStore.
      if (fastNativeFromStore(nid)) return;
      // First-click race — window.nodes[nid].console/.url are seeded ASYNC by the
      // flow island's topology reseed (~400-900ms after paint). Clicked before
      // that lands, openNativeConsole() would silently return (window.nodes[nid]
      // missing) or misroute to the web console (empty url) — the reported
      // "native console does nothing on first click, works after opening the web
      // console once" bug. Resolve the authoritative node table first, then do the
      // native handoff. The scheme lanes (telnet/ssh/vnc/spice/winbox) fire via an
      // anchor click (fireNativeHandler) with no window.open, so the post-fetch
      // handoff is gesture-safe; only the http/https new-tab lane could be
      // popup-blocked on this first click, and it surfaces the "allow popups" hint
      // instead of a silent no-op — still strictly better than nothing.
      ensureNodeMeta(nid, function () { openNativeConsole(nid); });
      return;
    }
    var node = null;
    try { node = window.nodes && window.nodes[nid]; } catch (e) {}
    // Warm path — metadata already seeded (after the island reseed / a refresh):
    // decide synchronously so any window.open stays inside the click gesture.
    if (node && node.console && node.url) {
      // Decision table (html5 ON — the only branch that reaches here):
      //   http/https + getMode()==='embed' → EMBED lane   (openEmbeddedProxyUrl: same-origin proxy iframe)   [NEW]
      //   http/https + getMode()==='tab'   → new-tab lane  (openNativeConsole → dispatchNativeLane)           [UNCHANGED]
      //   spice/winbox (native-only)        → native handoff (openNativeConsole)                              [UNCHANGED]
      //   telnet/ssh/vnc/rdp                → web console  (openWebConsole)                                   [UNCHANGED]
      var ct = String(node.console).toLowerCase();
      if ((ct === 'http' || ct === 'https') && getMode() === 'embed') openEmbeddedProxyUrl(nid, 1);
      else if (isNativeOnlyConsole(ct)) openNativeConsole(nid);
      else openWebConsole(nid);
      return;
    }
    // First-click race — metadata not seeded yet. We can't tell an http/https
    // node (which must open in its OWN browser tab via the webwait loader) from a
    // telnet/vnc web-console node, and the old code fell through to openWebConsole
    // and rendered the console as an in-page iframe. Pre-open a managed window NOW
    // (synchronously, in the click gesture, so a popup blocker can't kill it),
    // then resolve the node table and either navigate that window to the console
    // (http/https) or discard it and use the normal lane.
    //
    // EMBED mode is the exception: an http/https embed console renders in the
    // floating iframe (DOM), NOT a browser window — so there is no window.open to
    // protect from the popup blocker. Do NOT pre-open a placeholder; just resolve
    // the node table, then route http/https → the embed lane and everything else
    // through the normal fallbacks. TAB mode keeps the pre-open behavior exactly.
    if (getMode() === 'embed') {
      ensureNodeMeta(nid, function (n) {
        var ctype = n ? String(n.console || '').toLowerCase() : '';
        var running = !!(n && (n.status == 2 || n.status == 3));
        if (running && n.url && (ctype === 'http' || ctype === 'https')) { openEmbeddedProxyUrl(nid, 1); return; }
        if (running && n && isNativeOnlyConsole(n.console)) openNativeConsole(nid); // spice/winbox scheme handoff
        else openWebConsole(nid);                                                   // telnet/vnc/rdp web, or unresolved
      });
      return;
    }
    var pre = null;
    try { pre = window.open('about:blank', 'pnqweb-' + nid); } catch (e) {}
    if (pre) { try { pre.focus(); } catch (e) {} }
    ensureNodeMeta(nid, function (n) {
      var ctype = n ? String(n.console || '').toLowerCase() : '';
      var running = !!(n && (n.status == 2 || n.status == 3));
      if (running && n.url && (ctype === 'http' || ctype === 'https')) {
        var loaderUrl = webwaitUrl(n.url, n.name, nid, 1);
        if (pre && !pre.closed) { try { pre.location.replace(loaderUrl); return; } catch (e) {} }
        window.open(loaderUrl, 'pnqweb-' + nid);
        return;
      }
      // Not an http/https console: the placeholder isn't needed.
      if (pre && !pre.closed) { try { pre.close(); } catch (e) {} }
      if (running && n && isNativeOnlyConsole(n.console)) openNativeConsole(nid); // spice/winbox scheme handoff
      else openWebConsole(nid);                                                   // telnet/vnc/rdp web, or unresolved
    });
  }

  // "Console All", native lane: html5=0 has no combined native window (unlike
  // the web console's single tabbed iframe), so fire the per-node native
  // handoff for every currently-running node, staggered like EVE's old
  // native group-console loop (actions.js .action-openconsole-all/-group)
  // used to (setTimeout stagger avoids the browser's popup-blocker treating
  // a burst of window.open calls as spam). window.nodes is the same live
  // topology map openNativeConsole() reads per node.
  function openNativeConsoleAll() {
    var nodes = null;
    try { nodes = window.nodes; } catch (e) { return; }
    if (!nodes) return;
    var pending = 0;
    for (var nid in nodes) {
      if (!Object.prototype.hasOwnProperty.call(nodes, nid)) continue;
      var node = nodes[nid];
      if (!node || node.status != 2 && node.status != 3) continue;  // running only
      (function (id, delay) {
        setTimeout(function () { openNativeConsole(id); }, delay);
      })(nid, pending * 400);
      pending++;
    }
  }

  // html5-aware "Console All" — mirrors openHtml5AwareConsole for the group
  // action: web (combined tabbed window) when html5 is ON, native per-node
  // handoff for every running node when OFF.
  function openHtml5AwareConsoleAll() {
    if (html5Mode()) openWebConsoleAll(); else openNativeConsoleAll();
  }

  // Single click: swallow (BOTH modes) to prevent EVE's bubble-phase handler
  // from opening the console — the console now opens on dblclick only, uniformly.
  // Drag guard still applies so a drag ending on a node doesn't fire.
  document.addEventListener('click', function (e) {
    var t = e.target;
    var hit = t && t.closest ? t.closest('.nodehtmlconsole') : null;
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();                               // swallow — console opens on dblclick
  }, true);

  // Double-click: open the console — web console in html5 mode, the native
  // telnet/ssh/vnc handler in non-html5 mode.
  document.addEventListener('dblclick', function (e) {
    var t = e.target;
    var hit = t && t.closest ? t.closest('.nodehtmlconsole') : null;
    if (!hit) return;
    var nid = hit.getAttribute('nid');
    if (!nid) return;
    e.preventDefault();
    e.stopPropagation();
    openHtml5AwareConsole(nid);
  }, true);                                            // CAPTURE: runs before EVE's bubble handler

  /* ── 2nd console → web console too (was EVE's old native guacamole window) ──── */
  // The secondary console (.nodehtmlconsole2nd) is a DISTINCT lane+port on the node
  // (console_2nd / second port) — e.g. a Windows node with a primary RDP console and
  // a 2nd VNC view. The primary console already routes into the web console; the 2nd
  // was intentionally left to EVE's native handler (the old guacamole window). Route
  // it into the web console too, as its own window/tab. The 2nd console type comes
  // from the topology (window.nodes[nid].console_2nd); token_mint re-validates it
  // server-side (?second=1 → getconsole_2nd / getSecondPort).
  function open2ndConsole(nid) {
    var node = null;
    try { node = window.nodes && window.nodes[nid]; } catch (e) {}
    var name = (node && node.name) ? node.name : ('node ' + nid);
    // The 2nd console lane is resolved authoritatively in console.html from the
    // node's console_2nd (nodes API) — no need to know it here. EVE only renders
    // .nodehtmlconsole2nd for nodes that actually have a 2nd console.
    var url = CONSOLE_URL + '?node=' + encodeURIComponent(nid) + '&second=1';
    openConsoleWindow(url, 'n' + nid + '-2', 'Console 2 — ' + name);
    return true;
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    var hit = t && t.closest ? t.closest('.nodehtmlconsole2nd') : null;
    if (!hit) return;
    var nid = hit.getAttribute('nid');
    if (!nid) return;
    var node2 = null;
    try { node2 = window.nodes && window.nodes[nid]; } catch (e2) {}
    if (html5Mode() && !(node2 && isNativeOnlyConsole(node2.console_2nd))) {
      if (!open2ndConsole(nid)) return;                 // couldn't resolve a 2nd console → let EVE handle
    } else {
      // HTML5 off, OR a native-only 2nd type (spice/winbox/http/https) even with
      // HTML5 on (see isNativeOnlyConsole) → drive the native 2nd lane ourselves
      // (rdp .rdp download / telnet:// / vnc:// / spice:// / http(s) tab …).
      // EVE's bubble handler targets .nodehtmlconsole2nd DOM the flow island
      // never renders, so it's a dead no-op there.
      if (!node2 || (node2.status != 2 && node2.status != 3)) return;
      if (!dispatchNativeLane(node2.url_2nd, node2.console_2nd, (node2.name || 'node') + '-2', 'pnqweb-' + nid + '-2', nid, 2)) return;
    }
    e.preventDefault();
    e.stopPropagation();                                // pre-empt EVE's bubble-phase native window
  }, true);                                             // CAPTURE: runs before EVE's bubble handler

  /* ── "Console All" → html5-aware (was: combined web console only) ──────────── */
  // The quickbar "Console All" (.action-openconsole-all) and EVE's "console to all
  // nodes" group menu (.action-openconsole-group) otherwise open EVE's native
  // orange "Terminal" window (actions.js ~1301) — which targets `.nodehtmlconsole`
  // DOM that the flow-canvas island never renders, so that fallback is a dead
  // no-op there. Always intercept here and route via openHtml5AwareConsoleAll:
  // web (combined tabbed window) when html5 is ON, per-node native handoff for
  // every running node when html5 is OFF.
  document.addEventListener('click', function (e) {
    var t = e.target;
    var hit = t && t.closest ? t.closest('.action-openconsole-all, .action-openconsole-group') : null;
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    openHtml5AwareConsoleAll();
  }, true);

  window.pnqOpenWebConsole = openWebConsole;     // mode-respecting (quickbar / Slice 4)
  window.pnqOpenWebConsoleAll = openWebConsoleAll; // combined window, all node tabs
  window.pnqDetachWebConsole = detachWebConsole; // always in-lab window (side-by-side)
  window.pnqOpenConsoleWindow = openConsoleWindow; // arbitrary URL (packet capture)
  window.pnqHtml5Mode = html5Mode;                 // single source of truth (island reads this)
  window.pnqOpenConsoleAuto = openHtml5AwareConsole;      // html5-aware single-node console (island dblclick/menu)
  window.pnqOpenConsoleAllAuto = openHtml5AwareConsoleAll; // html5-aware "Console All" (island, if it grows a button)
  window.pnqOpenNativeConsole = openNativeConsole; // native handoff only (rarely needed directly)
  window.pnqFireCapture = openHtml5AwareCapture; // html5-aware capture (island Capture menu)
})();
