/**
 * pnetlab-shape-draw.js — persistent Polygon + Freeform shapes.
 *
 * Adds two drawing tools to the canvas "Add a new object" menu:
 *   • Polygon  — click to drop vertices; double-click / Enter / click-near-start
 *                closes it; Esc cancels.
 *   • Freeform — press-drag to trace a freehand outline; release to finish.
 *
 * Both produce a normal #customShapeN custom-shape whose inner <svg> is a
 * viewBox-scaled <polygon>/<path> with class .pnq-fillstroke and the shape div
 * carries data-pnq-vb="1" — i.e. the exact contract pnetlab-shape.js's extended
 * library uses. So the drawn shape is saved into the lab (createTextObject) and
 * inherits the resize handle, drag, style editor, duplicate and delete for free.
 * (This is the PERSISTENT counterpart to the ephemeral pnetlab-sketch.js overlay.)
 *
 * Screen→lab conversion mirrors the canvas transform (origin top-left, scale =
 * zoom): labX = (clientX - viewportRect.left) / zoom. The live preview is drawn
 * on a fixed full-screen SVG (pointer-events:none); input is captured at the
 * document level while a tool is armed, stopping propagation over the canvas so
 * the lasso / pan never fire mid-draw.
 */
(function () {
  'use strict';

  var ACCENT = '#3c708a';
  var DEF = { fill: '#ffffff', stroke: '#1d1d1f', bw: 2 };
  var CLOSE_PX = 10;           // click within this of the first vertex closes a polygon
  var MIN_STEP = 3;            // freeform: drop points closer than this (lab px)

  var mode = null;             // null | 'polygon' | 'freeform'
  var pts = [];                // captured points (lab coords)
  var curX = 0, curY = 0;      // live cursor (lab coords) for the rubber-band
  var ov = null;               // preview SVG overlay
  var hint = null;

  function vp() { return document.getElementById('lab-viewport'); }
  function island() { return document.getElementById('pnq-island-canvas-flow'); }
  // Flow island (default b1 canvas) publishes window.__pnqFlowXform = {active,
  // screenToLab(x,y), labToScreen(x,y)} (see CanvasFlow.svelte). When present, the
  // island owns the pan/zoom transform (its viewport is translated/scaled), so the
  // legacy #lab-viewport math would land shapes in the WRONG place. Prefer the bridge
  // when active; fall back to the legacy viewport math on the classic canvas.
  function flowX() { var f = window.__pnqFlowXform; return (f && f.active && typeof f.screenToLab === 'function' && typeof f.labToScreen === 'function') ? f : null; }
  function zoom() { var z = (typeof getZoomLab === 'function' ? getZoomLab() : 100) / 100; return z || 1; }
  function toLab(cx, cy) { var f = flowX(); if (f) return f.screenToLab(cx, cy); var r = vp().getBoundingClientRect(); var z = zoom(); return { x: (cx - r.left) / z, y: (cy - r.top) / z }; }
  function toScreen(p) { var f = flowX(); if (f) return f.labToScreen(p.x, p.y); var r = vp().getBoundingClientRect(); var z = zoom(); return { x: r.left + p.x * z, y: r.top + p.y * z }; }
  function msg(k, t) { if (typeof window.addMessage === 'function') window.addMessage(k, t); }
  // Signal the Svelte Flow island to reseed the topology so a just-created shape
  // renders without a reload (createTextObject writes via REST, never PNQStore).
  // Immediate + one delayed fire to catch async server state. Mirrors the pattern
  // pnetlab-shape.js/pnetlab-text.js use. Inert (no listener) on the classic canvas.
  function decoChanged() {
    try { document.dispatchEvent(new CustomEvent('pnq:decoration-changed')); } catch (e) {}
    setTimeout(function () { try { document.dispatchEvent(new CustomEvent('pnq:decoration-changed')); } catch (e) {} }, 800);
  }

  /* ── overlay preview ───────────────────────────────────────────────────────── */
  function ensureOverlay() {
    if (ov) return ov;
    ov = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ov.setAttribute('id', 'pnq-draw-ov');
    ov.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:100050;pointer-events:none;';
    document.body.appendChild(ov);
    return ov;
  }
  function clearOverlay() { if (ov) ov.innerHTML = ''; }
  function showHint(text) {
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'pnq-draw-hint';
      hint.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:100051;' +
        'background:rgba(30,30,32,.9);color:#fff;font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
        'padding:8px 14px;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.3);pointer-events:none;';
      document.body.appendChild(hint);
    }
    hint.textContent = text;
  }
  function hideHint() { if (hint) { hint.remove(); hint = null; } }

  function drawPreview() {
    var o = ensureOverlay(); o.innerHTML = '';
    if (!pts.length) return;
    var scr = pts.map(toScreen);
    var d = 'M' + scr.map(function (p) { return p.x + ',' + p.y; }).join(' L');
    if (mode === 'polygon') d += ' L' + toScreen({ x: curX, y: curY }).x + ',' + toScreen({ x: curX, y: curY }).y;
    var pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', d);
    pathEl.setAttribute('fill', 'none');
    pathEl.setAttribute('stroke', ACCENT);
    pathEl.setAttribute('stroke-width', '2');
    pathEl.setAttribute('stroke-dasharray', mode === 'polygon' ? '6,4' : '');
    o.appendChild(pathEl);
    if (mode === 'polygon') {
      scr.forEach(function (p, i) {
        var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', i === 0 ? 5 : 3);
        c.setAttribute('fill', i === 0 ? ACCENT : '#fff');
        c.setAttribute('stroke', ACCENT); c.setAttribute('stroke-width', '1.5');
        o.appendChild(c);
      });
    }
  }

  /* ── build + persist the drawn shape (vb custom-shape contract) ─────────────── */
  function nextId(cb) {
    if (typeof getTextObjects !== 'function') { cb(Date.now()); return; }
    getTextObjects().done(function (objs) { var i = 1; while (objs && objs['' + i] !== undefined) i++; cb(i); })
      .fail(function () { cb(Date.now()); });
  }
  function commit() {
    if (pts.length < (mode === 'polygon' ? 3 : 2)) { cancel(); return; }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(function (p) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
    var pad = DEF.bw + 1;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    var W = Math.max(20, Math.round(maxX - minX)), H = Math.max(20, Math.round(maxY - minY));
    var rel = pts.map(function (p) { return { x: +(p.x - minX).toFixed(1), y: +(p.y - minY).toFixed(1) }; });
    var inner;
    if (mode === 'polygon') {
      inner = '<polygon class="pnq-fillstroke" points="' +
        rel.map(function (p) { return p.x + ',' + p.y; }).join(' ') + '" fill="' + DEF.fill +
        '" stroke="' + DEF.stroke + '" stroke-width="' + DEF.bw + '" stroke-linejoin="round" vector-effect="non-scaling-stroke"></polygon>';
    } else {
      var d = 'M' + rel.map(function (p) { return p.x + ',' + p.y; }).join(' L') + ' Z';
      inner = '<path class="pnq-fillstroke" d="' + d + '" fill="' + DEF.fill +
        '" stroke="' + DEF.stroke + '" stroke-width="' + DEF.bw + '" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></path>';
    }
    var type = mode;
    var clean = function () { cancel(); };
    nextId(function (id) {
      var name = (mode === 'polygon' ? 'polygon ' : 'freeform ') + id;
      var html = '<div id="customShape' + id + '" class="customShape context-menu resizable-content" ' +
        'data-path="' + id + '" data-pnq-shape="' + type + '" data-pnq-vb="1" name="' + name + '" ' +
        'style="position:absolute; display:block; top:' + Math.round(minY) + 'px; left:' + Math.round(minX) +
        'px; width:' + W + 'px; height:' + H + 'px; cursor:move; z-index:1000;">' +
        '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
        inner + '</svg></div>';
      if (typeof createTextObject === 'function') {
        createTextObject({ data: html, name: name, type: 'shape' })
          .done(function () { msg('SUCCESS', (mode === 'polygon' ? 'Polygon' : 'Freeform') + ' added.'); decoChanged(); })
          .fail(function (m) { msg('DANGER', m || 'Add shape failed'); });
      }
      clean();
    });
  }

  function setCrosshair(on) {
    // Crosshair feedback over whichever canvas is live (classic viewport OR flow island).
    var v = vp(); if (v) v.style.cursor = on ? 'crosshair' : '';
    var isl = island(); if (isl) isl.style.cursor = on ? 'crosshair' : '';
  }

  function cancel() {
    mode = null; pts = [];
    clearOverlay(); hideHint();
    setCrosshair(false);
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    document.removeEventListener('dblclick', onDbl, true);
    document.removeEventListener('keydown', onKey, true);
  }

  /* ── input handlers (armed only while a tool is active) ─────────────────────── */
  function overCanvas(e) {
    var t = e.target;
    if (t.closest && t.closest('#lab-sidebar,#pnetlab-quickbar,#context-menu,.modal,.modal-dialog,#pnq-draw-hint')) return false;
    if (t === ov) return true;
    var v = vp();
    if (v && (t === v || v.contains(t))) return true;
    // Flow island (b1 default): its DOM covers the viewport, so the pointer actually
    // hits the island — accept targets inside it too (mirrors pnetlab-sketch.js ptInLab).
    var isl = island();
    return !!isl && (t === isl || isl.contains(t));
  }

  function onDown(e) {
    if (e.button !== 0 || !overCanvas(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    var p = toLab(e.clientX, e.clientY);
    if (mode === 'polygon') {
      // click near the first vertex closes the polygon
      if (pts.length >= 3) {
        var f = toScreen(pts[0]);
        if (Math.abs(e.clientX - f.x) <= CLOSE_PX && Math.abs(e.clientY - f.y) <= CLOSE_PX) { commit(); return; }
      }
      pts.push(p); curX = p.x; curY = p.y; drawPreview();
    } else {            // freeform: start the stroke
      pts = [p]; drawPreview();
    }
  }
  function onMove(e) {
    if (!mode) return;
    var p = toLab(e.clientX, e.clientY);
    curX = p.x; curY = p.y;
    if (mode === 'freeform' && (e.buttons & 1)) {
      var last = pts[pts.length - 1];
      if (!last || Math.abs(p.x - last.x) >= MIN_STEP || Math.abs(p.y - last.y) >= MIN_STEP) pts.push(p);
    }
    drawPreview();
  }
  function onUp(e) {
    if (mode === 'freeform' && pts.length >= 2) { e.preventDefault(); e.stopImmediatePropagation(); commit(); }
  }
  function onDbl(e) {
    if (mode !== 'polygon') return;
    e.preventDefault(); e.stopImmediatePropagation();
    // the dblclick's two clicks may have dropped a near-duplicate trailing vertex
    if (pts.length >= 2) {
      var a = pts[pts.length - 1], b = pts[pts.length - 2];
      if (Math.abs(a.x - b.x) < 6 && Math.abs(a.y - b.y) < 6) pts.pop();
    }
    commit();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter' && mode === 'polygon') { e.preventDefault(); commit(); }
  }

  function arm(which) {
    cancel();
    mode = which; pts = [];
    ensureOverlay();
    setCrosshair(true);
    showHint(which === 'polygon'
      ? 'Polygon: click to add points · double-click / Enter / click start to finish · Esc to cancel'
      : 'Freeform: press and drag to draw · release to finish · Esc to cancel');
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('dblclick', onDbl, true);
    document.addEventListener('keydown', onKey, true);
  }

  /* ── inject Polygon / Freeform into the "Add a new object" menu ──────────────── */
  function injectMenu(menu) {
    if (!menu || menu.dataset.pnqDraw) return;
    var textAdd = menu.querySelector('a.action-textadd');
    var nodePlace = menu.querySelector('a.action-nodeplace');
    if (!nodePlace) return;                              // not the add-object menu
    menu.dataset.pnqDraw = '1';
    var liP = document.createElement('li');
    liP.innerHTML = '<a class="pnq-draw-polygon" href="javascript:void(0)">' +
      '<i class="glyphicon glyphicon-star-empty"></i> Polygon</a>';
    var liF = document.createElement('li');
    liF.innerHTML = '<a class="pnq-draw-freeform" href="javascript:void(0)">' +
      '<i class="glyphicon glyphicon-pencil"></i> Freeform</a>';
    var anchorLi = textAdd ? textAdd.closest('li') : null;
    if (anchorLi && anchorLi.parentNode) {
      anchorLi.parentNode.insertBefore(liP, anchorLi);
      anchorLi.parentNode.insertBefore(liF, anchorLi);
    } else {
      var ul = menu.querySelector('ul, .dropdown-menu'); if (ul) { ul.appendChild(liP); ul.appendChild(liF); }
    }
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('.pnq-draw-polygon, .pnq-draw-freeform');
    if (!t) return;
    e.preventDefault(); e.stopImmediatePropagation();
    var cm = document.getElementById('context-menu'); if (cm) cm.remove();
    arm(t.classList.contains('pnq-draw-polygon') ? 'polygon' : 'freeform');
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
