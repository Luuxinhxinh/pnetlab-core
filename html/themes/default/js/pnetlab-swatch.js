/**
 * pnetlab-swatch.js — shared colour picker (Excalidraw / Open-Color style).
 *
 * Replaces <input type="color"> (the clunky native OS dialog) wherever the
 * topology UI needs a colour: Network Watcher filter rows, the Custom Shape
 * modal, the Properties panel (shape/text style) and the Text toolbar.
 *
 * The popover shows the Open-Color palette used by Excalidraw: a row of
 * neutrals plus one shade-ramp row per hue, running SOFT (easy on the eyes) on
 * the left to VIVID on the right. A hex field at the bottom keeps arbitrary
 * values reachable. Soft pastel tones are the leftmost column so a calmer,
 * lower-contrast colour is always one click away.
 *
 * API (window.pnqSwatch) — unchanged, callers depend on it:
 *   open(anchorEl, currentHex, cb)  — popover near anchorEl; cb('#rrggbb')
 *   attach(btnEl[, initialHex])     — turn a <button> into a colour chip:
 *       stores its colour in data-color, paints itself, opens the popover on
 *       click. Returns the repaint fn (also on the element as __pnqSwatchPaint).
 *       Read via btn.dataset.color; set via
 *       btn.dataset.color = c; btn.__pnqSwatchPaint(). Picking fires a bubbling
 *       'change' event on the button.
 *
 * Self-injects its CSS (no store-bundle rebake needed). The chip class
 * .pnq-swatch-btn is also styled by the store css as a fallback.
 */
(function () {
  'use strict';

  var ACCENT = '#3c708a';

  /* Open-Color neutrals (white → grays → black). */
  var NEUTRALS = ['#ffffff', '#f1f3f5', '#dee2e6', '#adb5bd', '#868e96', '#495057', '#212529', '#000000'];

  /* Open-Color hue ramps. Each row is SOFT → VIVID (shades 1,3,5,7,9). */
  var HUES = [
    ['#ffe3e3', '#ffa8a8', '#ff6b6b', '#f03e3e', '#c92a2a'], // red
    ['#ffdeeb', '#faa2c1', '#f06595', '#d6336c', '#a61e4d'], // pink
    ['#f3d9fa', '#e599f7', '#cc5de8', '#ae3ec9', '#862e9c'], // grape
    ['#e5dbff', '#b197fc', '#845ef7', '#7048e8', '#5f3dc4'], // violet
    ['#dbe4ff', '#91a7ff', '#5c7cfa', '#4263eb', '#364fc7'], // indigo
    ['#d0ebff', '#74c0fc', '#339af0', '#1c7ed6', '#1864ab'], // blue
    ['#c5f6fa', '#66d9e8', '#22b8cf', '#1098ad', '#0b7285'], // cyan
    ['#c3fae8', '#63e6be', '#20c997', '#0ca678', '#087f5b'], // teal
    ['#d3f9d8', '#8ce99a', '#51cf66', '#37b24d', '#2b8a3e'], // green
    ['#e9fac8', '#c0eb75', '#94d82d', '#74b816', '#5c940d'], // lime
    ['#fff3bf', '#ffe066', '#fcc419', '#f59f00', '#e67700'], // yellow
    ['#ffe8cc', '#ffc078', '#ff922b', '#f76707', '#d9480f']  // orange
  ];

  /* Flat list of every cell, for selection lookup / back-compat consumers. */
  var PALETTE = NEUTRALS.concat.apply(NEUTRALS, HUES);

  var pop = null;

  /* ── inject CSS once ──────────────────────────────────────────────────── */
  function injectCSS() {
    if (document.getElementById('pnq-swatch2-style')) return;
    var s = document.createElement('style');
    s.id = 'pnq-swatch2-style';
    s.textContent =
      '.pnq-swatch2-pop{position:fixed;z-index:100040;padding:10px;background:#fff;' +
      'border:1px solid rgba(0,0,0,.12);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.24);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}' +
      '.pnq-sw2-row{display:flex;gap:4px;margin-bottom:4px;}' +
      '.pnq-sw2-row.hues{margin-bottom:3px;}' +
      '.pnq-sw2-cell{width:18px;height:18px;border-radius:5px;border:1px solid rgba(0,0,0,.10);' +
      'cursor:pointer;padding:0;transition:transform .08s ease;flex:0 0 auto;}' +
      '.pnq-sw2-cell:hover{transform:scale(1.18);box-shadow:0 1px 5px rgba(0,0,0,.25);}' +
      '.pnq-sw2-cell.light{border-color:rgba(0,0,0,.22);}' +
      '.pnq-sw2-cell.sel{outline:2px solid ' + ACCENT + ';outline-offset:1px;}' +
      '.pnq-sw2-hint{display:flex;justify-content:space-between;font-size:9px;color:#9aa0a6;' +
      'letter-spacing:.04em;text-transform:uppercase;margin:2px 1px 5px;}' +
      '.pnq-sw2-hex{display:flex;align-items:center;gap:5px;margin-top:7px;padding-top:8px;' +
      'border-top:1px solid rgba(0,0,0,.08);}' +
      '.pnq-sw2-hex span{font-size:12px;color:#86868b;}' +
      '.pnq-sw2-hex input{width:74px;padding:4px 6px;border:1px solid rgba(0,0,0,.16);border-radius:7px;' +
      'font-size:12px;font-family:ui-monospace,Menlo,monospace;outline:none;color:#1d1d1f;}' +
      '.pnq-sw2-hex input:focus{border-color:' + ACCENT + ';box-shadow:0 0 0 3px rgba(60,112,138,.16);}' +
      '.pnq-sw2-cur{width:22px;height:22px;border-radius:6px;border:1px solid rgba(0,0,0,.15);margin-left:auto;}' +
      'body.pnq-dark .pnq-swatch2-pop{background:#2b2d31;border-color:rgba(255,255,255,.14);}' +
      'body.pnq-dark .pnq-sw2-cell{border-color:rgba(255,255,255,.18);}' +
      'body.pnq-dark .pnq-sw2-hex span{color:#aab;}' +
      'body.pnq-dark .pnq-sw2-hex input{background:#1f2123;color:#eee;border-color:rgba(255,255,255,.18);}';
    (document.head || document.documentElement).appendChild(s);
  }

  function isLight(c) {
    var m = /^#([0-9a-f]{6})$/i.exec(c || '');
    if (!m) return false;
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 190;
  }
  function clampHex(v) {
    v = (v || '').trim().replace(/^#/, '');
    return /^[0-9a-fA-F]{6}$/.test(v) ? '#' + v.toLowerCase() : null;
  }

  function close() {
    if (!pop) return;
    pop.remove(); pop = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  function onDocDown(e) { if (pop && !pop.contains(e.target)) close(); }

  function open(anchor, current, cb) {
    injectCSS();
    close();
    var cur = (current || '').toLowerCase();
    pop = document.createElement('div');
    pop.className = 'pnq-swatch2-pop';

    function makeCell(c) {
      var s = document.createElement('button');
      s.type = 'button';
      s.className = 'pnq-sw2-cell' + (isLight(c) ? ' light' : '') + (c === cur ? ' sel' : '');
      s.style.background = c;
      s.title = c;
      // mousedown (not click) + preventDefault keeps any live text selection
      // intact so the Text toolbar's foreColor applies to the right range.
      s.addEventListener('mousedown', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        close(); cb(c);
      });
      return s;
    }

    // neutrals row
    var nrow = document.createElement('div');
    nrow.className = 'pnq-sw2-row';
    NEUTRALS.forEach(function (c) { nrow.appendChild(makeCell(c)); });
    pop.appendChild(nrow);

    // soft → vivid hint over the hue ramps
    var hint = document.createElement('div');
    hint.className = 'pnq-sw2-hint';
    hint.innerHTML = '<span>soft</span><span>vivid</span>';
    pop.appendChild(hint);

    // one shade-ramp row per hue
    HUES.forEach(function (ramp) {
      var row = document.createElement('div');
      row.className = 'pnq-sw2-row hues';
      ramp.forEach(function (c) { row.appendChild(makeCell(c)); });
      pop.appendChild(row);
    });

    // hex field + current preview
    var hexRow = document.createElement('div');
    hexRow.className = 'pnq-sw2-hex';
    var hash = document.createElement('span'); hash.textContent = '#';
    var hx = document.createElement('input');
    hx.type = 'text'; hx.maxLength = 6; hx.spellcheck = false;
    hx.value = (clampHex(cur) || '').replace('#', '');
    var prev = document.createElement('div'); prev.className = 'pnq-sw2-cur';
    prev.style.background = clampHex(cur) || '#ffffff';
    hx.addEventListener('input', function () {
      var v = clampHex(hx.value);
      if (v) prev.style.background = v;
    });
    hx.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var v = clampHex(hx.value);
        if (v) { close(); cb(v); }
      }
    });
    hexRow.append(hash, hx, prev);
    pop.appendChild(hexRow);

    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    var left = Math.min(window.innerWidth - pop.offsetWidth - 8, Math.max(8, r.left));
    var top = r.bottom + 6;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = r.top - pop.offsetHeight - 6;
    pop.style.left = left + 'px';
    pop.style.top = Math.max(8, top) + 'px';
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  }

  function attach(btn, initial) {
    btn.classList.add('pnq-swatch-btn');
    if (initial) btn.dataset.color = initial;
    if (!btn.dataset.color) btn.dataset.color = PALETTE[0];
    function paint() {
      btn.style.background = btn.dataset.color;
      btn.classList.toggle('pnq-swatch-light', isLight(btn.dataset.color));
    }
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (btn.disabled) return;
      open(btn, btn.dataset.color, function (c) {
        btn.dataset.color = c;
        paint();
        btn.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
    paint();
    btn.__pnqSwatchPaint = paint;
    return paint;
  }

  window.pnqSwatch = { open: open, attach: attach, PALETTE: PALETTE.slice() };
})();
