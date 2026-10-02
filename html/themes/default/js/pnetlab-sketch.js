/**
 * pnetlab-sketch.js — Excalidraw-style annotation overlay for the topology page.
 *
 * A session-only sketch layer over the lab canvas, opened from a left-sidebar
 * "Sketch" entry. Tools (small floating palette):
 *   • Pencil    — freehand smoothed strokes; 6 colour swatches + width slider.
 *   • Laser     — ephemeral red trail that fades out (~0.8 s); never stored.
 *   • Eraser    — stroke-level: drag over any part of a stroke to remove it.
 *   • Clear all — wipe every stroke at once.
 *
 * Strokes are screen-fixed and persist across pan/zoom (they do NOT transform
 * with the lab, by design) and are removed only by the eraser / Clear all.
 * Nothing is written into the .unl — this is a pure in-browser overlay.
 *
 * Mechanics (mirrors pnetlab-canvas-nav.js): two stacked position:fixed canvases
 * (#pnq-sketch-ink, #pnq-sketch-laser) that are ALWAYS pointer-events:none, so the
 * overlay never blocks the sidebar / palette / topbar / menus / topology. Drawing
 * is driven by document-level mouse/touch listeners that are attached ONLY while a
 * tool is active and act ONLY over the lab canvas (chrome excluded) — so when no
 * tool is selected the topology keeps full drag / select / right-click / link-drag.
 */
(function () {
  'use strict';

  /* ── config ───────────────────────────────────────────────────────────────── */
  var COLORS = ['#ff2d2d', '#ffcc00', '#34c759', '#3b82f6', '#ffffff', '#1c1c1c'];
  var DEFAULT_COLOR = '#ff2d2d';
  var DEFAULT_WIDTH = 3;
  var ERASE_R = 14;            // px hit radius for stroke-level erase
  var LASER_LIFE = 800;        // ms before a laser point fully fades
  var LASER_COLOR = '#ff2d2d';
  // sidebar / overlays / menus where a draw gesture must NOT start
  var CHROME = '#lab-sidebar,#pnetlab-quickbar,#pnq-sketch-palette,#pnq-sysmon,' +
    '#context-menu,#capture-menu,.modal,.modal-dialog';

  /* ── state ────────────────────────────────────────────────────────────────── */
  var mode = null;            // null | 'pencil' | 'eraser' | 'laser'
  var color = DEFAULT_COLOR;
  var width = DEFAULT_WIDTH;
  var strokes = [];           // [{color,width,points:[{x,y}]}]  (screen px)
  var laser = [];             // [{x,y,t}]  ephemeral
  var drawing = null;         // active gesture
  var inkCanvas, inkCtx, laserCanvas, laserCtx;
  var rafId = null;
  var paletteEl = null, paletteOpen = false;
  var drawListeners = false;

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function W() { return window.innerWidth; }
  function H() { return window.innerHeight; }

  /* ── canvases ─────────────────────────────────────────────────────────────── */
  function sizeCanvas(c) {
    var dpr = window.devicePixelRatio || 1;
    c.width = Math.round(W() * dpr);
    c.height = Math.round(H() * dpr);
    c.style.width = W() + 'px';
    c.style.height = H() + 'px';
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // draw in CSS px; backing store is DPR-sharp
    return ctx;
  }
  function ensureCanvases() {
    if (inkCanvas) return;
    inkCanvas = el('canvas'); inkCanvas.id = 'pnq-sketch-ink';
    laserCanvas = el('canvas'); laserCanvas.id = 'pnq-sketch-laser';
    // z:1500/1501 — ABOVE the flow island wrapper (#pnq-island-canvas-flow is a
    // position:fixed z:1041 stacking context, so everything it renders is capped at
    // 1041 vs body-level siblings); still BELOW the quickbar (1850), sidebar (1900),
    // and #context-menu (91000). Both canvases are pointer-events:none, so they only
    // paint — drawing is driven by the document-level capture listeners (attachDraw).
    inkCanvas.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:1500;';
    laserCanvas.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:1501;';
    document.body.appendChild(inkCanvas);
    document.body.appendChild(laserCanvas);
    inkCtx = sizeCanvas(inkCanvas);
    laserCtx = sizeCanvas(laserCanvas);
    renderInk();
  }
  function onResize() {
    if (!inkCanvas) return;
    inkCtx = sizeCanvas(inkCanvas);
    laserCtx = sizeCanvas(laserCanvas);
    renderInk();
  }

  /* ── ink (pencil) rendering ───────────────────────────────────────────────── */
  function strokePath(ctx, s) {
    var p = s.points;
    if (!p || !p.length) return;
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
    ctx.lineWidth = s.width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (p.length === 1) {                                  // a tap → a dot
      ctx.beginPath(); ctx.arc(p[0].x, p[0].y, Math.max(0.5, s.width / 2), 0, Math.PI * 2); ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    if (p.length === 2) { ctx.lineTo(p[1].x, p[1].y); }
    else {                                                 // quadratic midpoint smoothing
      for (var i = 1; i < p.length - 1; i++) {
        var mx = (p[i].x + p[i + 1].x) / 2, my = (p[i].y + p[i + 1].y) / 2;
        ctx.quadraticCurveTo(p[i].x, p[i].y, mx, my);
      }
      ctx.lineTo(p[p.length - 1].x, p[p.length - 1].y);
    }
    ctx.stroke();
  }
  function renderInk() {
    if (!inkCtx) return;
    inkCtx.clearRect(0, 0, W(), H());
    for (var i = 0; i < strokes.length; i++) strokePath(inkCtx, strokes[i]);
  }
  function inkSeg(col, w, x0, y0, x1, y1) {                // live raw segment while drawing
    if (!inkCtx) return;
    inkCtx.strokeStyle = col; inkCtx.lineWidth = w; inkCtx.lineJoin = 'round'; inkCtx.lineCap = 'round';
    inkCtx.beginPath(); inkCtx.moveTo(x0, y0); inkCtx.lineTo(x1, y1); inkCtx.stroke();
  }

  /* ── laser rendering (rAF, alpha-decaying) ────────────────────────────────── */
  function pushLaser(x, y) { laser.push({ x: x, y: y, t: performance.now() }); scheduleLaser(); }
  function scheduleLaser() { if (rafId == null) rafId = requestAnimationFrame(renderLaser); }
  function clearLaserCanvas() { if (laserCtx) laserCtx.clearRect(0, 0, W(), H()); }
  function renderLaser() {
    rafId = null;
    if (!laserCtx) return;
    var now = performance.now();
    while (laser.length && now - laser[0].t > LASER_LIFE) laser.shift();
    clearLaserCanvas();
    if (!laser.length) return;
    laserCtx.lineJoin = 'round'; laserCtx.lineCap = 'round';
    laserCtx.strokeStyle = LASER_COLOR; laserCtx.lineWidth = 4;
    laserCtx.shadowColor = LASER_COLOR; laserCtx.shadowBlur = 8;
    for (var i = 1; i < laser.length; i++) {
      var a = laser[i - 1], b = laser[i];
      var alpha = Math.max(0, 1 - (now - b.t) / LASER_LIFE);
      if (alpha <= 0) continue;
      laserCtx.globalAlpha = alpha;
      laserCtx.beginPath(); laserCtx.moveTo(a.x, a.y); laserCtx.lineTo(b.x, b.y); laserCtx.stroke();
    }
    var head = laser[laser.length - 1];                    // bright head dot
    laserCtx.globalAlpha = 1; laserCtx.shadowBlur = 12; laserCtx.fillStyle = LASER_COLOR;
    laserCtx.beginPath(); laserCtx.arc(head.x, head.y, 4, 0, Math.PI * 2); laserCtx.fill();
    laserCtx.globalAlpha = 1; laserCtx.shadowBlur = 0;
    scheduleLaser();                                       // keep animating until it fades out
  }

  /* ── stroke-level eraser ──────────────────────────────────────────────────── */
  function eraseAt(x, y) {
    var changed = false, r2 = ERASE_R * ERASE_R;
    for (var i = strokes.length - 1; i >= 0; i--) {
      var pts = strokes[i].points, hit = false;
      for (var j = 0; j < pts.length; j++) {
        var dx = pts[j].x - x, dy = pts[j].y - y;
        if (dx * dx + dy * dy <= r2) { hit = true; break; }
      }
      if (hit) { strokes.splice(i, 1); changed = true; }
    }
    if (changed) renderInk();
  }

  /* ── draw gesture (mouse + touch, attached only while a tool is active) ───── */
  function ptInLab(t) {
    if (!t || (t.closest && t.closest(CHROME))) return false;
    // Classic canvas: the target must be inside #lab-viewport. Flow canvas (b1
    // default): the flow island (#pnq-island-canvas-flow) covers the viewport, so
    // its DOM is what the pointer actually hits — accept targets inside it too so
    // drawing works over the flow canvas. Strokes stay SCREEN-space (they don't
    // pan/zoom with the flow viewport — same behaviour class as the legacy canvas
    // pan; acceptable for b1).
    var v = document.getElementById('lab-viewport');
    if (v && (t === v || v.contains(t))) return true;
    var island = document.getElementById('pnq-island-canvas-flow');
    return !!island && (t === island || island.contains(t));
  }
  function begin(x, y) {
    if (mode === 'pencil') drawing = { type: 'pencil', color: color, width: width, points: [{ x: x, y: y }] };
    else if (mode === 'eraser') { drawing = { type: 'eraser' }; eraseAt(x, y); }
    else if (mode === 'laser') { drawing = { type: 'laser' }; pushLaser(x, y); }
  }
  function move(x, y) {
    if (!drawing) return;
    if (drawing.type === 'pencil') {
      var p = drawing.points, l = p[p.length - 1];
      p.push({ x: x, y: y }); inkSeg(drawing.color, drawing.width, l.x, l.y, x, y);
    } else if (drawing.type === 'eraser') eraseAt(x, y);
    else if (drawing.type === 'laser') pushLaser(x, y);
  }
  function end() {
    if (drawing && drawing.type === 'pencil' && drawing.points.length) {
      strokes.push({ color: drawing.color, width: drawing.width, points: drawing.points });
      renderInk();                                          // redraw the committed stroke smoothed
    }
    drawing = null;
  }
  function onMouseDown(e) {
    if (e.button !== 0 || !mode || !ptInLab(e.target)) return;
    e.preventDefault(); e.stopPropagation(); begin(e.clientX, e.clientY);
  }
  function onMouseMove(e) { if (!drawing) return; e.preventDefault(); e.stopPropagation(); move(e.clientX, e.clientY); }
  function onMouseUp(e) { if (!drawing) return; e.preventDefault(); e.stopPropagation(); end(); }
  function onClickSwallow(e) { if (mode && ptInLab(e.target)) { e.preventDefault(); e.stopPropagation(); } }
  function onTouchStart(e) {
    if (!mode) return;
    var t = e.changedTouches[0]; if (!ptInLab(t.target || e.target)) return;
    e.preventDefault(); e.stopPropagation(); begin(t.clientX, t.clientY);
  }
  function onTouchMove(e) { if (!drawing) return; var t = e.changedTouches[0]; e.preventDefault(); e.stopPropagation(); move(t.clientX, t.clientY); }
  function onTouchEnd(e) { if (!drawing) return; e.preventDefault(); end(); }

  function attachDraw(on) {
    if (on === drawListeners) return;
    var m = on ? 'addEventListener' : 'removeEventListener', cap = { capture: true };
    var capPassive = { capture: true, passive: false };
    document[m]('mousedown', onMouseDown, cap);
    document[m]('mousemove', onMouseMove, cap);
    document[m]('mouseup', onMouseUp, cap);
    document[m]('click', onClickSwallow, cap);
    document[m]('touchstart', onTouchStart, capPassive);
    document[m]('touchmove', onTouchMove, capPassive);
    document[m]('touchend', onTouchEnd, cap);
    drawListeners = on;
  }

  /* ── palette UI ───────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById('pnq-sketch-style')) return;
    var st = el('style'); st.id = 'pnq-sketch-style';
    st.textContent =
      '#pnq-sketch-palette{position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:1520;' +
      'display:flex;flex-direction:column;gap:6px;padding:7px 9px;' +
      'background:rgba(20,28,24,0.86);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
      'border:1px solid rgba(255,255,255,0.14);border-radius:11px;box-shadow:0 6px 22px rgba(0,0,0,0.32);' +
      'font:12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#e8ecea;pointer-events:auto;}' +
      '#pnq-sketch-palette .pnq-sk-tools{display:flex;flex-direction:column;gap:5px;align-items:center;}' +
      '#pnq-sketch-palette .pnq-sk-btn{width:30px;height:30px;border:1px solid rgba(255,255,255,0.16);' +
      'background:rgba(255,255,255,0.06);color:#e8ecea;border-radius:7px;cursor:pointer;font-size:13px;line-height:1;padding:0;}' +
      '#pnq-sketch-palette .pnq-sk-btn:hover{background:rgba(255,255,255,0.14);}' +
      '#pnq-sketch-palette .pnq-sk-btn.active{background:#34c759;border-color:#34c759;color:#0b1f12;}' +
      '#pnq-sketch-palette .pnq-sk-btn svg{vertical-align:middle;}' +
      '#pnq-sketch-palette .pnq-sk-btn[data-tool="laser"]{color:#ff2d2d;}' +
      '#pnq-sketch-palette .pnq-sk-btn.active[data-tool="laser"]{color:#0b1f12;}' +
      '#pnq-sketch-palette .pnq-sk-clear{margin-top:4px;}' +
      '#pnq-sketch-palette .pnq-sk-opts{display:flex;flex-direction:column;align-items:center;gap:8px;' +
      'padding-top:4px;border-top:1px solid rgba(255,255,255,0.12);margin-top:2px;}' +
      '#pnq-sketch-palette .pnq-sk-swatches{display:flex;flex-wrap:wrap;gap:4px;max-width:64px;justify-content:center;}' +
      '#pnq-sketch-palette .pnq-sk-sw{width:18px;height:18px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;}' +
      '#pnq-sketch-palette .pnq-sk-sw.active{border-color:#fff;box-shadow:0 0 0 1px rgba(0,0,0,0.4);}' +
      '#pnq-sketch-palette .pnq-sk-width{width:64px;}' +
      // Cursor feedback over BOTH the classic viewport and the flow island (b1).
      'body.pnq-sk-active #lab-viewport,body.pnq-sk-active #lab-viewport *,' +
      'body.pnq-sk-active #pnq-island-canvas-flow,body.pnq-sk-active #pnq-island-canvas-flow *{cursor:crosshair !important;}' +
      'body.pnq-sk-pencil #lab-viewport,body.pnq-sk-pencil #lab-viewport *,' +
      'body.pnq-sk-pencil #pnq-island-canvas-flow,body.pnq-sk-pencil #pnq-island-canvas-flow *{cursor:url(data:image/svg+xml,' +
      '%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%2224%22%20height=%2224%22%20viewBox=%220%200%2024%2024%22%3E' +
      '%3Cpath%20d=%22M3%2021l3.5-1L20%206.5a2.12%202.12%200%200%200-3-3L3.5%2017%203%2021z%22%20fill=%22%23ffcc00%22%20' +
      'stroke=%22%231c1c1c%22%20stroke-width=%221.3%22%20stroke-linejoin=%22round%22/%3E' +
      '%3Cpath%20d=%22M15.5%205l3%203%22%20stroke=%22%231c1c1c%22%20stroke-width=%221.3%22/%3E%3C/svg%3E) 3 21,crosshair !important;}' +
      'body.pnq-sk-eraser #lab-viewport,body.pnq-sk-eraser #lab-viewport *,' +
      'body.pnq-sk-eraser #pnq-island-canvas-flow,body.pnq-sk-eraser #pnq-island-canvas-flow *{cursor:cell !important;}';
    document.head.appendChild(st);
  }
  function buildPalette() {
    if (paletteEl) return paletteEl;
    ensureCanvases();
    var p = el('div'); p.id = 'pnq-sketch-palette';
    p.innerHTML =
      '<div class="pnq-sk-tools">' +
      '<button class="pnq-sk-btn" data-tool="pencil" title="Pencil"><i class="fa fa-pencil"></i></button>' +
      '<button class="pnq-sk-btn" data-tool="eraser" title="Eraser"><i class="fa fa-eraser"></i></button>' +
      '<button class="pnq-sk-btn" data-tool="laser" title="Laser pointer">' +
      '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.25" ' +
      'stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(90 10 10)">' +
      '<path d="m9.644 13.69 7.774-7.773a2.357 2.357 0 0 0-3.334-3.334l-7.773 7.774L8 12l1.643 1.69Z"/>' +
      '<path d="m13.25 3.417 3.333 3.333M10 10l2-2M5 15l3-3M2.156 17.894l1-1M5.453 19.029l-.144-1.407' +
      'M2.377 11.887l.866 1.118M8.354 17.273l-1.194-.758M.953 14.652l1.408.13"/></g></svg></button>' +
      '<button class="pnq-sk-btn pnq-sk-clear" data-act="clear" title="Clear all"><i class="fa fa-trash"></i></button>' +
      '<button class="pnq-sk-btn pnq-sk-close" data-act="close" title="Close"><i class="fa fa-times"></i></button>' +
      '</div>' +
      '<div class="pnq-sk-opts">' +
      '<span class="pnq-sk-swatches"></span>' +
      '<input type="range" class="pnq-sk-width" min="1" max="14" value="' + width + '" title="Stroke width">' +
      '</div>';
    document.body.appendChild(p);
    var sw = p.querySelector('.pnq-sk-swatches');
    COLORS.forEach(function (c) {
      var b = el('button', 'pnq-sk-sw'); b.style.background = c; b.setAttribute('data-color', c);
      if (c === color) b.classList.add('active');
      sw.appendChild(b);
    });
    p.addEventListener('click', onPaletteClick);
    p.querySelector('.pnq-sk-width').addEventListener('input', function (e) {
      width = parseInt(e.target.value, 10) || DEFAULT_WIDTH;
    });
    paletteEl = p;
    return p;
  }
  function updateSwatches() {
    if (!paletteEl) return;
    paletteEl.querySelectorAll('.pnq-sk-sw').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-color') === color);
    });
  }
  function onPaletteClick(e) {
    var sw = e.target.closest('.pnq-sk-sw');
    if (sw) { color = sw.getAttribute('data-color'); updateSwatches(); if (mode !== 'pencil') setMode('pencil'); return; }
    var btn = e.target.closest('.pnq-sk-btn'); if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'clear') { strokes = []; laser = []; renderInk(); clearLaserCanvas(); return; }
    if (act === 'close') { closePalette(); return; }
    var tool = btn.getAttribute('data-tool');
    if (tool) setMode(mode === tool ? null : tool);
  }
  function setMode(m) {
    mode = m;
    if (paletteEl) {
      paletteEl.querySelectorAll('.pnq-sk-btn[data-tool]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-tool') === mode);
      });
      paletteEl.querySelector('.pnq-sk-opts').style.display = (mode === 'pencil') ? '' : 'none';
    }
    document.body.classList.toggle('pnq-sk-active', !!mode);
    document.body.classList.remove('pnq-sk-pencil', 'pnq-sk-eraser', 'pnq-sk-laser');
    if (mode) document.body.classList.add('pnq-sk-' + mode);
    attachDraw(!!mode);
    if (!mode) { drawing = null; }
  }

  /* ── sidebar entry + open/close ───────────────────────────────────────────── */
  function markSidebar(on) {
    var li = document.getElementById('pnq-sketch-toggle'); if (!li) return;
    var ic = li.querySelector('i'); if (ic) ic.className = on ? 'fa fa-pencil-square' : 'fa fa-pencil';
  }
  function openPalette() {
    buildPalette(); paletteEl.style.display = ''; paletteOpen = true;
    setMode('pencil'); updateSwatches(); markSidebar(true);
  }
  function closePalette() {
    if (paletteEl) paletteEl.style.display = 'none';
    paletteOpen = false; setMode(null); markSidebar(false);
  }
  function togglePalette() { paletteOpen ? closePalette() : openPalette(); }

  function injectSidebar() {
    if (document.getElementById('pnq-sketch-toggle')) return true;
    var ul = document.querySelector('#lab-sidebar ul');
    if (!ul) return false;
    var li = el('li'); li.id = 'pnq-sketch-toggle';
    li.innerHTML = '<a href="#"><i class="fa fa-pencil" style="font-size:16px;"></i>' +
      '<span class="lab-sidebar-title">Sketch</span></a>';
    li.querySelector('a').addEventListener('click', function (e) { e.preventDefault(); togglePalette(); });
    ul.appendChild(li);
    return true;
  }

  /* ── undo (Ctrl/Cmd+Z removes the last pencil stroke) ─────────────────────── */
  function onKeyDown(e) {
    if (!paletteOpen) return;                              // only while the palette is open
    var isZ = (e.key === 'z' || e.key === 'Z' || e.keyCode === 90);
    if (!isZ || e.shiftKey || e.altKey || !(e.ctrlKey || e.metaKey)) return;
    if (drawing || !strokes.length) return;                // nothing to undo (or mid-stroke)
    strokes.pop();
    renderInk();
    e.preventDefault(); e.stopPropagation();
  }

  /* ── boot ─────────────────────────────────────────────────────────────────── */
  function init() {
    injectStyle();
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKeyDown, true);
    if (!injectSidebar()) {
      var mo = new MutationObserver(function () { if (injectSidebar()) mo.disconnect(); });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
