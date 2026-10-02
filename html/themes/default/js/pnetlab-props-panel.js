/**
 * pnetlab-props-panel.js — shared right-docked "Properties" panel.
 *
 * Excalidraw-style editing surface for canvas objects. Replaces the old EVE
 * bottom bars (pnetlab-shape.js "Object Style Editor" / pnetlab-text.js "Text
 * Style Editor") with one panel docked to the right edge of the topology page.
 * Opening is still driven by each object's existing trigger (double-click /
 * right-click → Edit); the panel just hosts the controls and applies changes
 * live, exactly as the bottom bars did.
 *
 * The panel is a thin shell: it owns the dock position, header (title + close),
 * slide-in, single-instance behaviour and shared CSS. Callers fill the body
 * with their own field markup and wire their own live-apply listeners — so the
 * shape/text modules keep their field HTML and apply logic unchanged; only the
 * container moved from the bottom bar into this panel.
 *
 * API (window.pnqPropsPanel):
 *   open({ title, onClose }) → { body, close }
 *       body    — empty <div> to fill with fields (querySelector within it works
 *                 just like the old `editor` element did).
 *       close() — convenience alias for window.pnqPropsPanel.close().
 *       Opening a new panel first fires the previous panel's onClose so the
 *       prior owner can clean its state (e.g. drop the "editing" highlight).
 *   close()        — remove the panel WITHOUT firing onClose (the caller is
 *                    already tearing down). Idempotent.
 *   isOpen()       — boolean.
 *
 * onClose fires only when the USER dismisses the panel (× button, Esc, or a
 * click on empty canvas), never from close(); this avoids re-entrancy between a
 * module's closeStyleEditor() and the panel.
 *
 * Self-injects its CSS; fully engine-side (no store-bundle rebake).
 */
(function () {
  'use strict';

  var ACCENT = '#3c708a';
  var panel = null;        // the live panel element
  var onCloseCb = null;    // user-dismiss callback for the live panel

  function injectCSS() {
    if (document.getElementById('pnq-props-style')) return;
    var s = document.createElement('style');
    s.id = 'pnq-props-style';
    s.textContent =
      '.pnq-pp{position:fixed;top:64px;right:12px;width:268px;max-height:calc(100vh - 96px);' +
      'z-index:9000;display:flex;flex-direction:column;background:rgba(255,255,255,0.94);' +
      'backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);' +
      'border:1px solid rgba(0,0,0,0.10);border-radius:14px;box-shadow:0 16px 50px rgba(0,0,0,0.22);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden;' +
      'transform:translateX(8px);opacity:0;transition:transform .16s ease,opacity .16s ease;}' +
      '.pnq-pp.in{transform:none;opacity:1;}' +
      '.pnq-pp-head{display:flex;align-items:center;justify-content:space-between;padding:11px 13px;' +
      'border-bottom:1px solid rgba(0,0,0,0.08);cursor:move;}' +
      '.pnq-pp-title{font-size:13px;font-weight:600;color:#1d1d1f;letter-spacing:-.01em;}' +
      '.pnq-pp-close{border:none;background:rgba(0,0,0,0.05);color:#1d1d1f;width:24px;height:24px;' +
      'border-radius:7px;cursor:pointer;font-size:15px;line-height:1;display:flex;align-items:center;' +
      'justify-content:center;}' +
      '.pnq-pp-close:hover{background:rgba(0,0,0,0.10);}' +
      '.pnq-pp-body{padding:12px 13px 14px;overflow-y:auto;}' +
      /* vertical re-flow of the bottom-bar field markup the editors inject */
      '.pnq-pp-body .pnq-objstyle-fields,.pnq-pp-body .pnq-textstyle-fields{display:flex;' +
      'flex-direction:column;gap:11px;align-items:stretch;}' +
      '.pnq-pp-body .pnq-objstyle-block,.pnq-pp-body .pnq-textstyle-block{display:flex;' +
      'flex-direction:column;gap:5px;}' +
      '.pnq-pp-body .pnq-objstyle-brow,.pnq-pp-body .pnq-textstyle-brow{display:flex;align-items:center;' +
      'gap:7px;flex-wrap:wrap;}' +
      '.pnq-pp-body .pnq-objstyle-input,.pnq-pp-body .pnq-textstyle-input{width:auto;}' +
      '.pnq-pp-body input[type="range"]{flex:1 1 90px;min-width:80px;}' +
      '.pnq-pp-body input[type="text"]:not(.pnq-objstyle-hex):not(.pnq-textstyle-hex),' +
      '.pnq-pp-body select{flex:1 1 auto;width:auto !important;}' +
      /* the panel supplies its own actions row styling for text Save/Cancel */
      '.pnq-pp-body .pnq-textstyle-actions{display:flex;gap:8px;margin-top:14px;}' +
      '.pnq-pp-body .pnq-textstyle-btn{flex:1 1 0;padding:7px 0;border-radius:8px;cursor:pointer;' +
      'font-size:13px;font-family:inherit;border:1px solid rgba(0,0,0,0.13);background:rgba(0,0,0,0.05);' +
      'color:#1d1d1f;}' +
      '.pnq-pp-body .pnq-textstyle-save{background:' + ACCENT + ';color:#fff;border-color:' + ACCENT + ';font-weight:500;}' +
      'body.pnq-dark .pnq-pp{background:rgba(40,42,46,0.94);border-color:rgba(255,255,255,0.12);}' +
      'body.pnq-dark .pnq-pp-title{color:#f2f2f3;}' +
      'body.pnq-dark .pnq-pp-head{border-color:rgba(255,255,255,0.10);}' +
      'body.pnq-dark .pnq-pp-close{background:rgba(255,255,255,0.08);color:#f2f2f3;}';
    (document.head || document.documentElement).appendChild(s);
  }

  function fireUserClose() {
    var cb = onCloseCb; onCloseCb = null;
    if (typeof cb === 'function') { try { cb(); } catch (e) {} }
  }

  function removePanel() {
    if (!panel) return;
    var p = panel; panel = null; onCloseCb = null;
    p.classList.remove('in');
    setTimeout(function () { if (p && p.parentNode) p.remove(); }, 160);
  }

  // Drag the panel by its header to reposition (it defaults to the right dock).
  function makeDraggable(p) {
    var head = p.querySelector('.pnq-pp-head');
    if (!head) return;
    head.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || e.target.closest('.pnq-pp-close')) return;
      e.preventDefault();
      var r = p.getBoundingClientRect();
      var dx = e.clientX - r.left, dy = e.clientY - r.top;
      p.style.right = 'auto';
      p.style.left = r.left + 'px';
      p.style.top = r.top + 'px';
      function mv(ev) {
        p.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - dx)) + 'px';
        p.style.top = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - dy)) + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', mv, true);
        document.removeEventListener('mouseup', up, true);
      }
      document.addEventListener('mousemove', mv, true);
      document.addEventListener('mouseup', up, true);
    });
  }

  function open(opts) {
    opts = opts || {};
    injectCSS();
    // opening a new editor → let the previous owner clean up, then swap
    if (panel) { fireUserClose(); removePanel(); }

    panel = document.createElement('div');
    panel.className = 'pnq-pp';
    panel.innerHTML =
      '<div class="pnq-pp-head"><span class="pnq-pp-title"></span>' +
      '<button type="button" class="pnq-pp-close" title="Close">&times;</button></div>' +
      '<div class="pnq-pp-body"></div>';
    panel.querySelector('.pnq-pp-title').textContent = opts.title || 'Properties';
    document.body.appendChild(panel);
    // slide in next frame
    requestAnimationFrame(function () { if (panel) panel.classList.add('in'); });

    onCloseCb = (typeof opts.onClose === 'function') ? opts.onClose : null;
    panel.querySelector('.pnq-pp-close').addEventListener('click', function () {
      fireUserClose(); removePanel();
    });
    makeDraggable(panel);

    return { body: panel.querySelector('.pnq-pp-body'), close: close };
  }

  function close() { onCloseCb = null; removePanel(); }
  function isOpen() { return !!panel; }

  // Esc dismisses (only when not editing text inline — those modules stop
  // propagation at capture for their own Esc handling).
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel) { fireUserClose(); removePanel(); }
  });

  window.pnqPropsPanel = { open: open, close: close, isOpen: isOpen };
})();
