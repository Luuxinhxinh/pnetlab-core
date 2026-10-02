/*
 * pnetlab-pan-button.js — restores the "Pan" hand-tool button to the left
 * quickbar (#pnq-buttons) after the Wave-3b amputation deleted
 * pnetlab-canvas-nav.js (which owned it).
 *
 * The Svelte Flow island ALREADY does the actual panning: it observes
 * `body.pnq-panmode` (→ panOnDrag: a plain left-drag pans while the class is on)
 * and has panActivationKey="Control" for Ctrl+drag. So all that was lost — and all
 * this restores — is the toggle surface: a hand button in the quickbar that flips
 * `body.pnq-panmode` (persisted in localStorage 'pnq_panmode' so it survives a lab
 * reopen). This file carries NONE of the deleted classic jsPlumb pan/zoom transform
 * logic — the island owns viewport transforms.
 *
 * CSP-safe (same-origin, no inline/eval), additive, idempotent. The active state
 * is shown with an inline highlight (there is no .pnq-btn-active CSS on this build).
 */
(function () {
  'use strict';
  var BTN_ID = 'pnq-pan-btn';
  var PM_KEY = 'pnq_panmode';

  function isPanMode() {
    try { return localStorage.getItem(PM_KEY) === '1'; } catch (e) { return false; }
  }
  function applyPanMode() {
    var on = isPanMode();
    document.body.classList.toggle('pnq-panmode', on);
    var b = document.getElementById(BTN_ID);
    if (b) {
      // inline highlight for the active hand tool (no .pnq-btn-active CSS here)
      b.style.background = on ? 'rgba(52,152,219,0.35)' : '';
      b.style.boxShadow = on ? 'inset 0 0 0 1px rgba(52,152,219,0.9)' : '';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  function togglePanMode(e) {
    if (e) e.preventDefault();
    try { localStorage.setItem(PM_KEY, isPanMode() ? '0' : '1'); } catch (_) {}
    applyPanMode();
  }

  function ensureButton() {
    var bar = document.getElementById('pnq-buttons');
    if (!bar || document.getElementById(BTN_ID)) { applyPanMode(); return; }
    // Pass 1 a11y hardening: real <button> (was a div) for Tab/Enter/Space.
    var b = document.createElement('button');
    b.type = 'button';
    b.id = BTN_ID;
    b.className = 'pnq-btn';
    b.title = 'Pan (hand tool) — drag the canvas to move the view; toggle off to edit. ' +
              'Ctrl+left-drag pans in either mode.';
    b.setAttribute('aria-label', 'Pan (hand tool)');
    b.innerHTML = '<i class="fa fa-hand-paper-o" aria-hidden="true"></i><span class="pnq-label">Pan</span>';
    b.addEventListener('click', togglePanMode);
    bar.appendChild(b);
    applyPanMode();
  }

  function init() {
    ensureButton();
    // the quickbar can render late / rebuild on lab open — keep re-inserting.
    new MutationObserver(ensureButton).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
